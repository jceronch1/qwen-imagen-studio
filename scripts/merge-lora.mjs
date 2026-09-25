// Fuses the official Viggle LoRA into the base transformer once, so inference needs no runtime LoRA.
// Delta = B·A·(alpha/r) is computed in float32 from the original BF16 adapter, added to the most
// precise base available (Q8_0 when downloaded, otherwise the Q4_K/BF16 values) and re-encoded
// with the exact tensor list, order and types of the Q4_K base (ggml Q4_K reference quantizer).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { open, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { TYPES, typeName, tensorBytes, readGGUF, ggufHeader, dequantQ8_0, dequantQ4_K, bf16ToFloat, floatToBf16, quantQ4_K } from './gguf.mjs';
import { mergedProofValid } from './core.mjs';

const rowSource = (type, buf, row, n, out) => {
  if (type === TYPES.Q8_0) return dequantQ8_0(Buffer.from(buf, row * n / 32 * 34, n / 32 * 34), out);
  if (type === TYPES.Q4_K) return dequantQ4_K(Buffer.from(buf, row * n / 256 * 144, n / 256 * 144), out);
  if (type === TYPES.BF16) return bf16ToFloat(Buffer.from(buf, row * n * 2, n * 2), out);
  if (type === TYPES.F32) { out.set(new Float32Array(buf, row * n * 4, n)); return out; }
  throw new Error('Tipo de origen no soportado: ' + typeName(type));
};
const rowBytes = (type, n) => type === TYPES.Q4_K ? n / 256 * 144 : type === TYPES.BF16 ? n * 2 : type === TYPES.F32 ? n * 4 : 0;

if (!isMainThread) {
  // Rows [row0,row1): x = base + scale * B[row] · A, processed 4 rows at a time to reuse each A row.
  parentPort.on('message', ({ id, srcType, src, dstType, dst, n, row0, row1, segments }) => {
    const xs = [0, 1, 2, 3].map(() => new Float32Array(n)), ds = [0, 1, 2, 3].map(() => new Float32Array(n)), bRows = new Float32Array(4 * 512);
    const segs = segments.map(s => ({ ...s, A: new Float32Array(s.A), B: new Float32Array(s.B) }));
    const [d0, d1, d2, d3] = ds;
    let deltaSq = 0, baseSq = 0;
    for (let row = row0; row < row1; row += 4) {
      const count = Math.min(4, row1 - row), seg = segs.find(s => row >= s.row0 && row < s.row1);
      assert.ok(seg && row + count <= seg.row1, 'Segmento LoRA inválido');
      const { A, B, r, scale } = seg;
      bRows.fill(0);
      for (let j = 0; j < count; j++) { rowSource(srcType, src, row + j, n, xs[j]); for (let k = 0; k < r; k++) bRows[j * r + k] = B[(row + j - seg.row0) * r + k] * scale; }
      for (const d of ds) d.fill(0);
      for (let k = 0; k < r; k++) {
        const b0 = bRows[k], b1 = bRows[r + k], b2 = bRows[2 * r + k], b3 = bRows[3 * r + k], a = k * n;
        for (let i = 0; i < n; i++) { const v = A[a + i]; d0[i] += b0 * v; d1[i] += b1 * v; d2[i] += b2 * v; d3[i] += b3 * v; }
      }
      for (let j = 0; j < count; j++) {
        const x = xs[j], d = ds[j];
        for (let i = 0; i < n; i++) { baseSq += x[i] * x[i]; deltaSq += d[i] * d[i]; x[i] += d[i]; }
        const out = Buffer.from(dst, (row + j) * rowBytes(dstType, n), rowBytes(dstType, n));
        if (dstType === TYPES.Q4_K) quantQ4_K(x, out);
        else if (dstType === TYPES.BF16) floatToBf16(x, out);
        else throw new Error('Tipo de destino no soportado: ' + typeName(dstType));
      }
    }
    parentPort.postMessage({ id, deltaSq, baseSq });
  });
} else {
  const root = resolve(import.meta.dirname, '..');
  const config = JSON.parse(await readFile(resolve(root, 'model-config.json'), 'utf8'));
  const models = resolve(root, 'models');
  const target = resolve(models, config.merged);
  const proofPath = resolve(models, 'merged-lora.json');
  const hash = async path => { const h = createHash('sha256'); for await (const c of createReadStream(path)) h.update(c); return h.digest('hex'); };
  const exists = path => stat(path).then(() => true, () => false);
  const args = process.argv.slice(2);
  const precisePath = args.find(a => a.endsWith('.gguf')) ?? resolve(root, '.downloads', config.preciseBase);

  try {
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    if (mergedProofValid(proof, config) && await exists(target) && proof.outputSha256 === await hash(target)) {
      console.log('Modelo con LoRA fusionado verificado; no necesita cambios.'); process.exit(0);
    }
  } catch (e) { if (e.code !== 'ENOENT') console.log('Se reconstruirá el modelo fusionado:', e.message); }
  if (args.includes('--verify')) { console.log('El modelo con LoRA fusionado no está instalado o no coincide.'); process.exit(2); }

  // The LoRA and the Q8_0 base are temporary downloads; the Q4_K base is optional (fallback installs keep it).
  const templatePath = resolve(models, config.base);
  const loraPath = [resolve(models, 'loras', config.lora), resolve(root, '.downloads', config.lora)].find(existsSync);
  assert.ok(loraPath, 'Falta el LoRA oficial ' + config.lora);
  console.log('Verificando archivos de origen…');
  assert.equal(await hash(loraPath), config.loraSha256, 'Hash inesperado en el LoRA oficial');
  let precise = null, template = null;
  if (await exists(precisePath)) {
    assert.equal(await hash(precisePath), config.preciseBaseSha256, 'Hash inesperado en el modelo base Q8_0');
    precise = await readGGUF(precisePath);
  } else console.log('Base Q8_0 no encontrada: se fusionará sobre los valores Q4_K (doble cuantización).');
  if (await exists(templatePath)) {
    assert.equal(await hash(templatePath), config.baseSha256, 'Hash inesperado en el modelo base Q4_K');
    template = await readGGUF(templatePath);
  }
  assert.ok(template || precise, 'Se necesita la base Q8_0 o la base Q4_K para fusionar el LoRA');
  // Without the Q4_K file, its layout is the Q8_0 one with every Q8_0 tensor stored as Q4_K (BF16 unchanged):
  // the tensor list, order and types of leejet's Q4_K release.
  const layout = template ?? { kv: precise.kv, alignment: precise.alignment, tensors: precise.tensors.map(t => t.type === TYPES.Q8_0 ? { ...t, type: TYPES.Q4_K, bytes: tensorBytes(TYPES.Q4_K, t.elements) } : t) };

  // Adapter layout: PEFT names, lora_A [r, in], lora_B [out, r], alpha from metadata.
  const lf = await open(loraPath, 'r');
  const lb = Buffer.alloc(8); await lf.read(lb, 0, 8, 0);
  const headerSize = Number(lb.readBigUInt64LE()), hb = Buffer.alloc(headerSize); await lf.read(hb, 0, headerSize, 8);
  const lh = JSON.parse(hb.toString()), meta = JSON.parse(lh.__metadata__?.lora_adapter_metadata ?? '{}');
  const rank = meta['transformer.r'], alpha = meta['transformer.lora_alpha'];
  assert.ok(rank > 0 && alpha > 0, 'El LoRA no declara rango y alpha');
  assert.deepEqual(meta['transformer.alpha_pattern'] ?? {}, {}); assert.deepEqual(meta['transformer.rank_pattern'] ?? {}, {});
  const scale = alpha / rank * config.loraScale;
  async function loraF32(key, shape) {
    const t = lh[key]; assert.ok(t, 'Falta ' + key); assert.equal(t.dtype, 'BF16'); assert.deepEqual(t.shape, shape);
    const bytes = Buffer.alloc(t.data_offsets[1] - t.data_offsets[0]); await lf.read(bytes, 0, bytes.length, 8 + headerSize + t.data_offsets[0]);
    const sab = new SharedArrayBuffer(bytes.length * 2); bf16ToFloat(bytes, new Float32Array(sab)); return sab;
  }
  const used = new Set();
  async function segmentsFor(t) {
    const [n, out] = t.ne, m = /^(?:(transformer_blocks\.\d+)\.(attn\.to_[qkv]|attn\.to_out\.0|img_mlp\.out|img_mlp\.gate_up)|(modulation\.1|time_text_embed\.timestep_embedder\.linear_[12]))\.weight$/.exec(t.name);
    if (!m) return null;
    const parts = m[2] === 'img_mlp.gate_up' ? [`${m[1]}.img_mlp.gate_layer`, `${m[1]}.img_mlp.proj`] : [m[3] ?? `${m[1]}.${m[2]}`];
    const rows = out / parts.length;
    return Promise.all(parts.map(async (p, i) => {
      const key = 'transformer.' + p; used.add(key + '.lora_A.weight'); used.add(key + '.lora_B.weight');
      return { row0: i * rows, row1: (i + 1) * rows, r: rank, scale, A: await loraF32(key + '.lora_A.weight', [rank, n]), B: await loraF32(key + '.lora_B.weight', [rows, rank]) };
    }));
  }

  const threads = Math.max(1, Math.min(availableParallelism(), Number(process.env.MERGE_THREADS) || availableParallelism()));
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
  let nextId = 0; const pending = new Map();
  for (const w of workers) w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); }).on('error', e => { for (const p of pending.values()) p({ error: e }); });
  const idle = [...workers], queue = [];
  const runTask = task => new Promise((ok, bad) => {
    const go = w => { const id = nextId++; pending.set(id, m => { idle.push(w); if (queue.length) queue.shift()(idle.pop()); m.error ? bad(m.error) : ok(m); }); w.postMessage({ ...task, id }); };
    idle.length ? go(idle.pop()) : queue.push(go);
  });

  const tensors = layout.tensors.map(t => ({ ...t }));
  const header = ggufHeader(layout.kv, tensors, layout.alignment);
  if (template) assert.equal(header.length, template.dataStart, 'La cabecera generada no coincide con la base');
  const dataStart = header.length;
  const out = await open(target + '.tmp', 'w');
  const started = Date.now(), stats = [];
  let written = 0;
  async function write(b, position) { let n = 0; while (n < b.length) { const r = await out.write(b, n, b.length - n, position + n); n += r.bytesWritten; } }
  try {
    await write(header, 0); written = header.length;
    let done = 0;
    for (const t of tensors) {
      const position = dataStart + t.offset, segments = await segmentsFor(t);
      let bytes;
      if (!segments) {
        const p = precise?.byName.get(t.name);
        if (template) bytes = await template.read(template.byName.get(t.name));
        else { assert.equal(p.type, t.type, 'Tensor sin LoRA con tipo distinto: ' + t.name); bytes = await precise.read(p); }
      }
      else {
        const [n, rows] = t.ne, p = precise?.byName.get(t.name);
        // Most precise source: Q8_0 for Q4_K tensors; BF16 tensors are identical in both releases.
        const usePrecise = p && p.ne.join() === t.ne.join() && (p.type === TYPES.Q8_0 || !template);
        const srcT = usePrecise ? p : template.byName.get(t.name), srcBytes = await (usePrecise ? precise : template).read(srcT);
        const src = new SharedArrayBuffer(srcBytes.length); Buffer.from(src).set(srcBytes);
        const dst = new SharedArrayBuffer(t.bytes);
        const chunk = Math.max(4, Math.ceil(rows / (threads * 4) / 4) * 4), tasks = [];
        for (let row0 = 0; row0 < rows; row0 += chunk) tasks.push(runTask({ srcType: srcT.type, src, dstType: t.type, dst, n, row0, row1: Math.min(rows, row0 + chunk), segments }));
        const results = await Promise.all(tasks);
        const deltaSq = results.reduce((a, b) => a + b.deltaSq, 0), baseSq = results.reduce((a, b) => a + b.baseSq, 0);
        stats.push({ name: t.name, type: typeName(t.type), source: typeName(srcT.type), relativeDelta: Math.sqrt(deltaSq / baseSq) });
        bytes = Buffer.from(dst);
        done++;
        process.stdout.write(`\rFusionando LoRA: ${done} tensores · ${Math.round((Date.now() - started) / 1000)} s   `);
      }
      assert.equal(bytes.length, t.bytes);
      await write(bytes, position);
      const padded = Math.ceil(t.bytes / layout.alignment) * layout.alignment;
      if (padded > t.bytes) await write(Buffer.alloc(padded - t.bytes), position + t.bytes);
      written = position + padded;
    }
  } finally { await out.close(); await Promise.all(workers.map(w => w.terminate())); await template?.close(); await precise?.close(); await lf.close(); }
  console.log('');
  const adapterKeys = Object.keys(lh).filter(k => k !== '__metadata__');
  assert.equal(used.size, adapterKeys.length, `Se usaron ${used.size} de ${adapterKeys.length} tensores del LoRA`);
  assert.equal((await stat(target + '.tmp')).size, written, 'El modelo fusionado quedó incompleto');
  if (template) assert.equal(written, (await stat(templatePath)).size, 'El tamaño del modelo fusionado no coincide con la base');
  const outputSha256 = await hash(target + '.tmp');
  await rm(target, { force: true }); await rename(target + '.tmp', target);
  const proof = { output: config.merged, outputSha256, outputBytes: (await stat(target)).size, base: template ? config.base : null, baseSha256: template ? config.baseSha256 : null, layout: template ? 'GGUF Q4_K base' : 'GGUF Q8_0 base, tensores Q8_0 como Q4_K', preciseBase: precise ? config.preciseBase : null, preciseBaseSha256: precise ? config.preciseBaseSha256 : null, lora: config.lora, loraSha256: config.loraSha256, rank, alpha, scale, adapterTensors: adapterKeys.length, mergedTensors: stats.length, seconds: Math.round((Date.now() - started) / 1000), method: 'W = base + (alpha/r)·B·A en float32; recodificado con los tipos y orden de la publicación Q4_K de leejet (cuantizador Q4_K de referencia de ggml).', maxRelativeDelta: Math.max(...stats.map(s => s.relativeDelta)), tensors: stats };
  await writeFile(proofPath, JSON.stringify(proof, null, 2));
  console.log(`Modelo fusionado: ${config.merged} · ${stats.length} tensores · ${adapterKeys.length} tensores LoRA · ${proof.seconds} s`);
}
