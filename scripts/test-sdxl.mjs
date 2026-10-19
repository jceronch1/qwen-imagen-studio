import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validate, enginePayload, outputSize } from './core.mjs';
import { chooseMode, engineArgs, engineFeatures, sageCapable } from './engine-manager.mjs';
import { presetFor, MODEL_FILE } from './models.mjs';
const root = resolve(import.meta.dirname, '..');
const id = 'sdxl:NoobAI-XL-v1.1.safetensors', base = { model: id, prompt: '1girl, solo, night sky', width: 1344, height: 768, seed: 7 };

// Validation: recommended settings by default, SDXL-only limits.
const p = validate(base), preset = presetFor(id);
assert.equal(p.steps, 28); assert.equal(p.cfg, 5); assert.equal(p.sampler, 'euler_a'); assert.equal(p.negativePrompt, preset.negative.trim());
assert.equal(validate({ ...base, negativePrompt: '' }).negativePrompt, '');
assert.equal(validate({ prompt: 'x' }).model, 'qwen');
for (const bad of [{ model: 'sdxl:../evil.safetensors' }, { model: 'sdxl:a.ckpt' }, { model: 'flux' }, { cfg: 0.5 }, { cfg: 16 }, { sampler: 'ddim' }, { steps: 61 },
  { refs: ['data:image/png;base64,iVBORw0KGgo='] }, { loras: [{ file: '../x.safetensors', weight: 1 }] }, { loras: [{ file: 'a.safetensors', weight: 3 }] },
  { loras: Array.from({ length: 5 }, (_, i) => ({ file: `l${i}.safetensors`, weight: 1 })) }, { hires: true, width: 1536, height: 1536 }])
  assert.throws(() => validate({ ...base, ...bad }), undefined, JSON.stringify(bad));
assert.ok(!MODEL_FILE.test('..\\x.safetensors'));

// Payload: quality tags once, CFG and negative prompt, LoRAs by file name, Karras scheduler, wallpaper pass.
const pay = enginePayload(validate({ ...base, sampler: 'dpm++2m_karras', loras: [{ file: 'frieren.safetensors', weight: 0.8 }], hires: true }), 2);
assert.ok(pay.prompt.startsWith(preset.prefix)); assert.ok(pay.prompt.endsWith(base.prompt));
assert.equal(enginePayload(validate({ ...base, prompt: preset.prefix + 'x' })).prompt, preset.prefix + 'x');
assert.equal(enginePayload(validate({ ...base, qualityTags: false })).prompt, base.prompt);
assert.equal(pay.seed, 9); assert.equal(pay.sample_params.guidance.txt_cfg, 5); assert.equal(pay.sample_params.sample_method, 'dpm++2m'); assert.equal(pay.sample_params.scheduler, 'karras');
assert.deepEqual(pay.lora, [{ path: 'frieren.safetensors', multiplier: 0.8, is_high_noise: false }]);
assert.equal(pay.hires.enabled, true); assert.equal(pay.hires.scale, 1.5); assert.equal(pay.hires.steps, 14); assert.equal(pay.vae_tiling_params.enabled, true);
assert.deepEqual(outputSize(validate({ ...base, hires: true })), { width: 2016, height: 1152 });
assert.equal(enginePayload(p).hires.enabled, false); assert.equal(enginePayload(p).sample_params.scheduler, undefined); assert.ok(!('custom_sigmas' in enginePayload(p).sample_params));

// Engine: single-file checkpoint, runtime LoRAs, flash attention, weights in RAM on GPU (4–6 GB cards).
const gtx = { cpuAvailable: true, gpus: [{ id: 'CUDA0', name: 'NVIDIA GeForce GTX 1060 6GB', runtime: 'runtime-v0.2.1' }] };
const sel = chooseMode('gpu', gtx), args = engineArgs(sel, 0, 7999, engineFeatures(sel, true, id));
assert.ok(args[args.indexOf('--model') + 1].endsWith('NoobAI-XL-v1.1.safetensors')); assert.ok(!args.includes('--diffusion-model')); assert.ok(!args.includes('--llm'));
assert.ok(args.includes('--offload-to-cpu')); assert.ok(args.includes('--diffusion-fa')); assert.ok(!args.includes('--sage-attn')); assert.equal(args[args.indexOf('--lora-apply-mode') + 1], 'at_runtime');
assert.ok(engineArgs(chooseMode('cpu', gtx), 4, 7999, engineFeatures(chooseMode('cpu', gtx), true, id)).includes('--mmap'));
// SageAttention needs compute capability 8.0: never on GTX 10xx/16xx or RTX 20xx.
for (const name of ['NVIDIA GeForce GTX 1080', 'NVIDIA GeForce GTX 1050 Ti', 'NVIDIA GeForce GTX 1660 SUPER', 'NVIDIA GeForce RTX 2060']) assert.equal(sageCapable({ device: 'CUDA0', name }), false, name);
for (const name of ['NVIDIA GeForce RTX 3060', 'NVIDIA GeForce RTX 4070 Laptop GPU', 'NVIDIA GeForce RTX 5090', 'NVIDIA RTX A4000']) assert.equal(sageCapable({ device: 'CUDA0', name }), true, name);
assert.equal(engineFeatures(sel, true).attention, 'flash');
assert.equal(engineFeatures(chooseMode('gpu', { cpuAvailable: true, gpus: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 4070', runtime: 'r' }] }), true).attention, 'sage');
assert.equal(engineFeatures({ device: 'Vulkan0', name: 'NVIDIA GeForce RTX 4070' }, true).attention, 'flash');
console.log('PASS SDXL validation, payload (tags, CFG, negative, LoRA, Karras, wallpaper ×1.5), single-file engine arguments and SageAttention GPU gating.');

// End to end with a simulated engine: the request reaches it as SDXL and the record keeps the settings.
await mkdir(resolve(root, 'qa'), { recursive: true });
const dir = await mkdtemp(resolve(root, 'qa', 'sdxl-'));
const png = (await readFile(resolve(root, 'scripts', 'fixtures', 'muestra.png'))).toString('base64');
const received = [];
const engine = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('capabilities')) return res.end(JSON.stringify({ supported_modes: ['img_gen'] }));
  if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; received.push(JSON.parse(raw)); return res.end(JSON.stringify({ id: 'job' })); }
  res.end(JSON.stringify({ status: 'completed', result: { images: [{ b64_json: png }] } }));
});
await new Promise(r => engine.listen(7886, '127.0.0.1', r));
const child = spawn(process.execPath, [resolve(root, 'scripts/server.mjs')], { cwd: root, env: { ...process.env, QWEN_PORT: '7885', QWEN_ENGINE_PORT: '7886', QWEN_OUTPUT_DIR: dir }, stdio: 'ignore' });
const api = async (path, method = 'GET', body) => { const r = await fetch('http://127.0.0.1:7885' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
try {
  for (let i = 0; i < 40; i++) { try { await api('/api/status'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const models = (await api('/api/models')).data; assert.ok(Array.isArray(models.models) && Array.isArray(models.loras));
  const job = await api('/api/jobs', 'POST', { ...base, count: 2, hires: true, negativePrompt: 'lowres', loras: [{ file: 'estilo.safetensors', weight: 0.7 }] });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  let final; for (let i = 0; i < 100; i++) { final = (await api('/api/jobs/' + job.data.id)).data; if (['completed', 'failed'].includes(final.status)) break; await new Promise(r => setTimeout(r, 200)); }
  assert.equal(final.status, 'completed', final.message);
  assert.deepEqual(received.map(r => r.seed), [7, 8]); assert.equal(received[0].negative_prompt, 'lowres'); assert.equal(received[0].hires.enabled, true); assert.ok(!('ref_images' in received[0]));
  const [record] = (await api('/api/gallery')).data;
  assert.equal(record.model, id); assert.equal(record.family, 'sdxl'); assert.equal(record.outputWidth, 2016); assert.equal(record.cfg, 5); assert.deepEqual(record.loras, [{ file: 'estilo.safetensors', weight: 0.7 }]);
  console.log('PASS SDXL job end to end (simulated engine): 2 seeds, negative prompt, LoRA and wallpaper pass recorded in the library.');
} finally { child.kill(); engine.close(); }
