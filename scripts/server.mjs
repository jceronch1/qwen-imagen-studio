import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { validate, enginePayload, MODEL } from './core.mjs';
import { EngineManager, chooseMode } from './engine-manager.mjs';
import { logOffset, recentLog, diagnoseFailure } from './engine-diagnostics.mjs';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.QWEN_PORT || 7871), enginePort = Number(process.env.QWEN_ENGINE_PORT || 7872);
const engine = `http://127.0.0.1:${enginePort}`;
const outputs = resolve(root, process.env.QWEN_OUTPUT_DIR || 'outputs');
await mkdir(outputs, { recursive: true });
const manager = process.env.QWEN_ENGINE_MANAGED === '1' ? new EngineManager(enginePort) : null;
let active = null;
let deleting = false;
const jobs = new Map();
const pause = ms => new Promise(r => setTimeout(r, ms));
async function engineRequest(path, body) {
  const r = await fetch(engine + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || data.error || `Motor: HTTP ${r.status}`);
  return data;
}
function publicJob(job) { const { params, engineId, ...rest } = job; return rest; }
async function run(job) {
  const errorLogStart = manager ? await logOffset() : 0;
  try {
    let selected = { merged: false, convDirect: false };
    if(manager){
      job.message='Preparando el motor para '+job.params.compute+'. Cambiar de dispositivo requiere recargar los modelos.';
      selected=await manager.ensure(job.params.compute,job.params.threads,job.params.fastAttention);
      job.computeUsed=selected.mode; job.device=selected.device;
    }
    for (let i = 0; i < job.params.count; i++) {
      if (job.cancelRequested) break;
      job.status = 'generating'; job.current = i + 1;
      job.message = `Creando imagen ${i + 1} de ${job.params.count}.`;
      const imageStarted = Date.now(), payload = enginePayload(job.params, i, selected);
      const submitted = await engineRequest('/sdcpp/v1/img_gen', payload);
      job.engineId = submitted.id;
      let result;
      do {
        if (job.cancelRequested && !job.cancelSent) {
          job.cancelSent = true;
          // The image can finish between polling and cancellation. Read its terminal state either way.
          await engineRequest(`/sdcpp/v1/jobs/${job.engineId}/cancel`, {}).catch(() => {});
        }
        await pause(250);
        result = await engineRequest(`/sdcpp/v1/jobs/${job.engineId}`);
      } while (!['completed','failed','cancelled'].includes(result.status));
      job.engineId = null;
      if (result.status === 'cancelled') { job.cancelRequested = true; break; }
      if (result.status === 'failed') throw new Error(result.error?.message || 'El motor no pudo generar la imagen.');
      const image = result.result?.images?.[0]?.b64_json;
      if (!image) throw new Error('El motor no devolvió una imagen.');
      const id = randomUUID(), name = `${id}.png`, bytes = Buffer.from(image, 'base64');
      if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('La respuesta del motor no es un PNG válido.');
      const { refs, ...params } = job.params;
      const loraRecord = selected.merged ? { loraApplication:'merged', mergedModel:MODEL.merged } : { loraApplication:'runtime', runtimeLora:MODEL.runtimeLora, runtimeLoraSha256:MODEL.runtimeLoraSha256 };
      const record = { ...params, weightStorage:manager?selected.weights:'external', attention:selected.attention||'external', vaeTiling:payload.vae_tiling_params.enabled, computeUsed:job.computeUsed||'external', device:job.device||'external', count: 1, id, seed: params.seed + i, refsCount: refs.length, src: `/outputs/${name}`, createdAt: new Date().toISOString(), model: MODEL.source, modelVersion:MODEL.version, modelRevision:MODEL.revision, lora:MODEL.lora, ...loraRecord, baseRevision:MODEL.baseRevision, loraScale:MODEL.loraScale, baseModel:MODEL.baseSource, quantization: 'Q4_K', scheduler: 'Turbo v0.2.1 FlowMatchEuler, shift_terminal=null', sigmas:payload.sample_params.custom_sigmas, seconds: Math.round((Date.now() - imageStarted)/100)/10, batchSeconds: Math.round((Date.now() - job.startedAt)/1000) };
      await writeFile(resolve(outputs, name), bytes);
      if (refs.length) await writeFile(resolve(outputs, `${id}.refs.json`), JSON.stringify(refs));
      await writeFile(resolve(outputs, `${id}.json.tmp`), JSON.stringify(record, null, 2));
      await rename(resolve(outputs, `${id}.json.tmp`), resolve(outputs, `${id}.json`));
      job.images.push(record);
    }
    job.status = job.cancelRequested ? 'cancelled' : 'completed';
    job.message = job.cancelRequested ? 'Generación cancelada. Las imágenes terminadas se conservaron.' : 'Imágenes guardadas en tu biblioteca local.';
  } catch (error) {
    const diagnosis = diagnoseFailure(error.message, manager ? await recentLog(errorLogStart) : '');
    let released=false;
    if(manager){try{await manager.stop();released=true;}catch{}}
    job.status = 'failed'; job.errorCode=diagnosis.code; job.message=diagnosis.message;
    if(released)job.message+=' Se cerró el motor para liberar su memoria; se cargará de nuevo al reintentar.';
    if(job.images.length)job.message+=' Se conservaron las '+job.images.length+' imágenes terminadas.';
  } finally { job.finishedAt = Date.now(); active = null; }
}
async function gallery() {
  const files = (await readdir(outputs)).filter(f => /^[a-f0-9-]{36}\.json$/.test(f));
  const items = await Promise.all(files.map(f => readFile(resolve(outputs,f),'utf8').then(JSON.parse)));
  return items.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); }
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 36*1024*1024) throw Object.assign(new Error('Solicitud demasiado grande.'), { status:413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('JSON inválido.'), { status:400 }); }
}
const server = createServer(async (req,res) => {
  try {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res,403,{error:'Host no permitido.'});
    if (req.headers.origin && !allowedHosts.some(h => req.headers.origin === `http://${h}`)) return json(res,403,{error:'Origen no permitido.'});
    const url = new URL(req.url, `http://127.0.0.1:${port}`), path = url.pathname;
    if (req.method === 'GET' && path === '/api/status') {
      let ready = false;
      try { const r = await fetch(engine+'/sdcpp/v1/capabilities',{signal:AbortSignal.timeout(1500)}); const caps = await r.json(); ready = r.ok && caps.supported_modes?.includes('img_gen'); } catch {}
      const compute = manager?.snapshot() || {managed:false};
      // A job submitted while the engine loads waits for it, so loading does not block the button.
      if(manager)ready=compute.canGenerate;
      return json(res,200,{ app:'qwen-turbo-local', ready, compute, active: active ? publicJob(active) : null, model:`Qwen 2.1 · Viggle Turbo v${MODEL.version} · Q4_K + LoRA r256`, modelVersion:MODEL.version, recommendedSteps:MODEL.recommendedSteps });
    }
    if (req.method === 'POST' && path === '/api/engine/warmup') {
      if (!manager) return json(res,200,{managed:false});
      const params = validate({ ...(await readBody(req)), prompt:'warmup', refs:[] });
      try { chooseMode(params.compute, await manager.detection); } catch (e) { return json(res,400,{error:e.message}); }
      if (!active) void manager.warm(params.compute, params.threads, params.fastAttention);
      return json(res,202,manager.snapshot());
    }
    if (req.method === 'GET' && path === '/api/gallery') return json(res,200,await gallery());
    if (req.method === 'POST' && path === '/api/jobs') {
      if (active || deleting) return json(res,409,{error:'Espera a que termine la operación en curso.'});
      const params = validate(await readBody(req));
      if (active || deleting) return json(res,409,{error:'Espera a que termine la operación en curso.'});
      if(!manager&&params.compute!=='auto')return json(res,400,{error:'Este servidor usa un motor externo. Usa "Iniciar Qwen Imagen Studio.cmd" para seleccionar CPU/GPU.'});
      if(manager){chooseMode(params.compute,await manager.detection);if(active||deleting)return json(res,409,{error:'Espera a que termine la operación en curso.'});}
      const job = { id:randomUUID(), params, status:'queued', startedAt:Date.now(), current:0, total:params.count, images:[], seed:params.seed, message:'Preparando el motor local…', cancelRequested:false };
      active = job; jobs.set(job.id,job);
      for (const [id,old] of jobs) if (jobs.size > 100 && old !== active) jobs.delete(id);
      json(res,202,publicJob(job)); void run(job); return;
    }
    const match = /^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return json(res,404,{error:'Trabajo no encontrado.'});
      if (req.method === 'POST' && match[2]) {
        job.cancelRequested = true;
        job.message = 'Se detendrá al finalizar la imagen en curso. No se iniciarán más imágenes del lote.';
        return json(res,200,publicJob(job));
      }
      if (req.method === 'GET' && !match[2]) return json(res,200,publicJob(job));
    }
    const refMatch = /^\/api\/references\/([a-f0-9-]{36})$/.exec(path);
    if (req.method === 'GET' && refMatch) { try { return json(res,200,JSON.parse(await readFile(resolve(outputs,`${refMatch[1]}.refs.json`),'utf8'))); } catch(e) { if(e.code === 'ENOENT') return json(res,200,[]); throw e; } }
    const deleteMatch = /^\/api\/gallery\/([a-f0-9-]{36})$/.exec(path);
    if (req.method === 'DELETE' && (deleteMatch || path === '/api/gallery' || path === '/api/gallery/selection')) {
      if (active || deleting) return json(res,409,{error:'Espera a que termine la generación u otra eliminación.'});
      deleting = true;
      try {
        const items = await gallery();
        let ids = null;
        if (path === '/api/gallery/selection') {
          const body = await readBody(req);
          if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 10000 || body.ids.some(id=>typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) return json(res,400,{error:'Selecciona al menos una imagen válida.'});
          ids = new Set(body.ids);
          if ([...ids].some(id=>!items.some(item=>item.id===id))) return json(res,409,{error:'La biblioteca cambió. Actualiza la selección.'});
        }
        const targets = ids ? items.filter(item=>ids.has(item.id)) : deleteMatch ? items.filter(item => item.id === deleteMatch[1]) : items;
        const trash = resolve(outputs,'.trash',randomUUID());
        await mkdir(trash,{recursive:true});
        for (const item of targets) {
          if (!/^[a-f0-9-]{36}$/.test(item.id)) continue;
          for (const ext of ['png','refs.json','json']) {
            const name = `${item.id}.${ext}`;
            await rename(resolve(outputs,name),resolve(trash,name)).catch(e=>{if(e.code !== 'ENOENT') throw e;});
          }
        }
        return json(res,200,{ok:true,deleted:targets.length});
      } finally { deleting = false; }
    }
    let file;
    if (req.method === 'GET' && ['/', '/style.css', '/app.js'].includes(path)) file = resolve(root,'app',path === '/' ? 'index.html' : path.slice(1));
    if (req.method === 'GET' && /^\/outputs\/[a-f0-9-]{36}\.(png|json)$/.test(path)) file = resolve(outputs,basename(path));
    if (file) { const bytes = await readFile(file); res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.json':'application/json'}[extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}); return res.end(bytes); }
    return json(res,404,{error:'No encontrado.'});
  } catch(error) { return json(res,error.status || (error.code === 'ENOENT' ? 404 : 500),{error:error.message}); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Qwen Imagen Studio: http://127.0.0.1:${port}`));
