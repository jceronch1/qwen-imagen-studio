import assert from 'node:assert/strict';
import { readFile,writeFile,stat,mkdir } from 'node:fs/promises';
await mkdir('qa/update-v021',{recursive:true});
import { createHash } from 'node:crypto';
import { MODEL } from './core.mjs';
const base='http://127.0.0.1:7871';
async function api(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw new Error(JSON.stringify(v));return v;}
async function run(params){const job=await api('/api/jobs',params);let j;const deadline=Date.now()+600000;do{j=await api('/api/jobs/'+job.id);if(j.status==='failed')throw new Error(j.message);if(Date.now()>deadline)throw new Error('timeout');if(j.status!=='completed')await new Promise(r=>setTimeout(r,1000));}while(j.status!=='completed');for(const im of j.images){const p=await readFile('outputs/'+im.id+'.png');assert.equal(p.readUInt32BE(16),params.width);assert.equal(p.readUInt32BE(20),params.height);assert.equal(im.modelVersion,MODEL.version);}console.log('Completed',j.images.map(x=>({id:x.id,seed:x.seed,refs:x.refsCount,seconds:x.seconds})));return j;}
const logStart=(await stat('logs/engine.out.log').catch(()=>({size:0}))).size;
const prompt='An editorial photograph of a red fox in a snowy forest at sunrise, soft mist, detailed fur, warm backlight, natural colors.';
const params={prompt,width:512,height:512,steps:6,seed:424242,count:2};
const t2i=await run(params);
const repeat=await run({...params,count:1});
function pixelsHash(p){let off=8;const h=createHash('sha256');while(off<p.length){const n=p.readUInt32BE(off);if(p.toString('ascii',off+4,off+8)==='IDAT')h.update(p.subarray(off+8,off+8+n));off+=n+12;}return h.digest('hex');}
assert.equal(pixelsHash(await readFile('outputs/'+t2i.images[0].id+'.png')),pixelsHash(await readFile('outputs/'+repeat.images[0].id+'.png')));
const refs=await Promise.all(t2i.images.map(async im=>'data:image/png;base64,'+(await readFile('outputs/'+im.id+'.png')).toString('base64')));
const edit=await run({prompt:'Place the two foxes from image 1 and image 2 together in a green meadow full of small yellow flowers. Keep the foxes red with realistic detailed fur. Photograph.',width:768,height:512,steps:6,seed:424244,count:1,refs});
const logs=(await readFile('logs/engine.out.log')).subarray(logStart).toString(), merged=t2i.images[0].loraApplication==='merged';
// Merged transformer: the LoRA is already in the weights and must not be applied twice.
if(merged){assert.ok(!/apply lora/i.test(logs),'The merged model must not load the LoRA again');for(const j of [t2i,repeat,edit])for(const im of j.images)assert.equal(im.loraApplication,'merged');}
else{assert.ok(logs.includes('(390 / 390) LoRA tensors have been applied')); assert.ok(!logs.includes('unused lora tensor'),'All LoRA tensors must apply');assert.ok(!logs.includes('Only ('),'Partial LoRA detected');}
await writeFile('qa/update-v021/verified.json',JSON.stringify({version:MODEL.version,date:new Date().toISOString(),t2i,repeat,edit,seedReproducible:true,loraApplication:merged?'merged':'runtime',noUnusedLoraTensors:!merged},null,2));
console.log('PASS v0.2.1: real batch, deterministic replay, two-reference editing, two sizes, LoRA '+(merged?'fused once (not reapplied)':'fully applied at runtime')+'.');
