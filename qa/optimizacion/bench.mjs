// Engine benchmark used to choose the settings (qa/optimizacion/benchmarks.jsonl). Env: DM=model file, NOLORA, NOTILE, VARY, PROMPT.
// Usage: node qa/optimizacion/bench.mjs <name> <runtime> <width> <height> <images> -- <extra sd-server args...>
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..').replaceAll('\\', '/');
const { enginePayload, MODEL } = await import('file:///' + root + '/scripts/core.mjs');
const [name, runtime, w, h, n, sep, ...extra] = process.argv.slice(2);
const out = resolve(import.meta.dirname, 'bench'); mkdirSync(out, { recursive: true });
const port = 7890;
const base = ['--diffusion-model', `${root}/models/${process.env.DM || MODEL.base}`, '--llm', `${root}/models/Qwen3VL-8B-Instruct-Q4_K_M.gguf`,
  '--llm_vision', `${root}/models/mmproj-Qwen3VL-8B-Instruct-F16.gguf`, '--vae', `${root}/models/qwen_image_2.1_vae_bf16.safetensors`,
  '--lora-model-dir', `${root}/models/loras`, '--cfg-scale', '1', '--sampling-method', 'euler',
  '--listen-ip', '127.0.0.1', '--listen-port', String(port), '--log-level', 'info'];
const logFile = resolve(out, `${name}.log`);
const fd = openSync(logFile, 'w');
const t0 = Date.now();
const child = spawn(`${root}/${runtime}/sd-server.exe`, [...base, ...extra], { cwd: root, windowsHide: true, stdio: ['ignore', fd, fd] });
closeSync(fd);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let peakVram = 0;
const vramTimer = setInterval(() => {
  import('node:child_process').then(({ execFile }) => execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (e, s) => { if (!e) peakVram = Math.max(peakVram, parseInt(s)); }));
}, 500);
try {
  for (;;) {
    if (child.exitCode !== null) throw new Error('engine exited ' + child.exitCode);
    try { const r = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/capabilities`); if (r.ok) break; } catch {}
    await sleep(300);
  }
  const ready = (Date.now() - t0) / 1000;
  const params = { prompt: process.env.PROMPT || 'A cozy reading nook by a rainy window, warm lamp light, stacked books, a sleeping orange cat on a knitted blanket, detailed photograph', width: +w, height: +h, steps: 6, seed: 424242, refs: [], transparent: false };
  const times = [];
  for (let i = 0; i < +n; i++) {
    const t = Date.now();
    const variants = ['', ', autumn evening', ', snowy morning light', ', a blue ceramic mug on the sill', ', film photography look'];
    const p = process.env.VARY ? { ...params, prompt: params.prompt + variants[i % variants.length] } : params;
    const r = await (await fetch(`http://127.0.0.1:${port}/sdcpp/v1/img_gen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...enginePayload(p, i), ...(process.env.REF ? { ref_images: [process.env.REF] } : {}), ...(process.env.NOLORA ? { lora: [] } : {}), ...(process.env.NOTILE ? { vae_tiling_params: { enabled: false } } : {}) }) })).json();
    let s;
    do { await sleep(250); s = await (await fetch(`http://127.0.0.1:${port}/sdcpp/v1/jobs/${r.id}`)).json(); } while (!['completed', 'failed', 'cancelled'].includes(s.status));
    if (s.status !== 'completed') throw new Error('job ' + s.status + ' ' + JSON.stringify(s.error));
    times.push((Date.now() - t) / 1000);
    writeFileSync(resolve(out, `${name}-${i}.png`), Buffer.from(s.result.images[0].b64_json, 'base64'));
  }
  const log = readFileSync(logFile, 'utf8');
  const grab = re => [...log.matchAll(re)].map(m => +m[1]);
  const res = { name, runtime, size: `${w}x${h}`, extra: extra.join(' '), ready, times,
    cond: grab(/get_learned_condition completed, taking ([\d.]+)s/g), sampling: grab(/sampling completed, taking ([\d.]+)s/g),
    decode: grab(/decode_first_stage completed, taking ([\d.]+)s/g), peakVramMiB: peakVram,
    params: (/total params memory size = [^\n]*/.exec(log) || [''])[0].slice(0, 140) };
  console.log(JSON.stringify(res));
  appendFileSync(resolve(out, 'results.jsonl'), JSON.stringify(res) + '\n');
} catch (e) { console.log('FAIL', name, e.message); appendFileSync(resolve(out, 'results.jsonl'), JSON.stringify({ name, error: e.message }) + '\n'); }
finally { clearInterval(vramTimer); child.kill(); await sleep(1500); }
