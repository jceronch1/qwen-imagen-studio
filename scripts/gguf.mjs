// Minimal GGUF v3 reader/writer and ggml block codecs used by merge-lora.mjs.
import { open } from 'node:fs/promises';

export const TYPES = { F32: 0, F16: 1, Q8_0: 8, Q4_K: 12, Q6_K: 14, BF16: 30 };
const BLOCK = { 0: [1, 4], 1: [1, 2], 8: [32, 34], 12: [256, 144], 14: [256, 210], 30: [1, 2] };
export const typeName = t => Object.keys(TYPES).find(k => TYPES[k] === t) ?? `type${t}`;
export function tensorBytes(type, elements) {
  const b = BLOCK[type];
  if (!b) throw new Error(`Tipo GGUF no soportado: ${type}`);
  if (elements % b[0]) throw new Error(`Número de elementos incompatible con ${typeName(type)}`);
  return elements / b[0] * b[1];
}

export async function readGGUF(path) {
  const file = await open(path, 'r');
  let buffer = Buffer.alloc(0), start = 0, pos = 0;
  async function need(n) {
    if (pos + n <= start + buffer.length) return;
    const size = Math.max(n, 16 << 20), b = Buffer.alloc(size);
    const { bytesRead } = await file.read(b, 0, size, pos);
    if (bytesRead < n) throw new Error('GGUF truncado: ' + path);
    buffer = b.subarray(0, bytesRead); start = pos;
  }
  const u32 = async () => { await need(4); const v = buffer.readUInt32LE(pos - start); pos += 4; return v; };
  const u64 = async () => { await need(8); const v = Number(buffer.readBigUInt64LE(pos - start)); pos += 8; return v; };
  const str = async () => { const n = await u64(); await need(n); const v = buffer.toString('utf8', pos - start, pos - start + n); pos += n; return v; };
  const scalar = { 0: [1, 'readUInt8'], 1: [1, 'readInt8'], 2: [2, 'readUInt16LE'], 3: [2, 'readInt16LE'], 4: [4, 'readUInt32LE'], 5: [4, 'readInt32LE'], 6: [4, 'readFloatLE'], 7: [1, 'readUInt8'], 10: [8, 'readBigUInt64LE'], 11: [8, 'readBigInt64LE'], 12: [8, 'readDoubleLE'] };
  async function value(type) {
    if (type === 8) return str();
    if (type === 9) { const t = await u32(), n = await u64(), a = []; for (let i = 0; i < n; i++) a.push(await value(t)); return { type: t, items: a }; }
    const [n, fn] = scalar[type] ?? []; if (!n) throw new Error('Tipo de metadato GGUF desconocido: ' + type);
    await need(n); const v = buffer[fn](pos - start); pos += n; return type === 7 ? !!v : v;
  }
  await need(24);
  if (buffer.toString('ascii', 0, 4) !== 'GGUF') throw new Error('No es un archivo GGUF: ' + path);
  pos = 4; const version = await u32(); if (version !== 3) throw new Error('Versión GGUF no soportada: ' + version);
  const tensorCount = await u64(), kvCount = await u64(), kv = [];
  for (let i = 0; i < kvCount; i++) { const key = await str(), type = await u32(); kv.push({ key, type, value: await value(type) }); }
  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = await str(), dims = await u32(), ne = [];
    for (let d = 0; d < dims; d++) ne.push(await u64());
    const type = await u32(), offset = await u64();
    const elements = ne.reduce((a, b) => a * b, 1);
    tensors.push({ name, ne, type, offset, elements, bytes: tensorBytes(type, elements) });
  }
  const alignment = kv.find(e => e.key === 'general.alignment')?.value ?? 32;
  const dataStart = Math.ceil(pos / alignment) * alignment;
  async function read(t) {
    const b = Buffer.alloc(t.bytes); let n = 0;
    while (n < t.bytes) { const r = await file.read(b, n, t.bytes - n, dataStart + t.offset + n); if (!r.bytesRead) throw new Error('GGUF truncado: ' + t.name); n += r.bytesRead; }
    return b;
  }
  return { path, version, kv, tensors, alignment, dataStart, read, close: () => file.close(), byName: new Map(tensors.map(t => [t.name, t])) };
}

// Writes metadata and tensor descriptors with the same layout rules as ggml's gguf writer.
export function ggufHeader(kv, tensors, alignment = 32) {
  const parts = [];
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const str = s => { const b = Buffer.from(s, 'utf8'); u64(b.length); parts.push(b); };
  const scalar = { 0: [1, 'writeUInt8'], 1: [1, 'writeInt8'], 2: [2, 'writeUInt16LE'], 3: [2, 'writeInt16LE'], 4: [4, 'writeUInt32LE'], 5: [4, 'writeInt32LE'], 6: [4, 'writeFloatLE'], 7: [1, 'writeUInt8'], 10: [8, 'writeBigUInt64LE'], 11: [8, 'writeBigInt64LE'], 12: [8, 'writeDoubleLE'] };
  function value(type, v) {
    if (type === 8) return str(v);
    if (type === 9) { u32(v.type); u64(v.items.length); for (const x of v.items) value(v.type, x); return; }
    const [n, fn] = scalar[type]; const b = Buffer.alloc(n); b[fn](type === 7 ? +v : v); parts.push(b);
  }
  parts.push(Buffer.from('GGUF', 'ascii')); u32(3); u64(tensors.length); u64(kv.length);
  for (const e of kv) { str(e.key); u32(e.type); value(e.type, e.value); }
  let offset = 0;
  for (const t of tensors) {
    str(t.name); u32(t.ne.length); for (const n of t.ne) u64(n); u32(t.type); u64(offset);
    t.offset = offset; offset += Math.ceil(t.bytes / alignment) * alignment;
  }
  const head = Buffer.concat(parts);
  return Buffer.concat([head, Buffer.alloc(Math.ceil(head.length / alignment) * alignment - head.length)]);
}

const f16 = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  f16[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
export const halfToFloat = h => f16[h];
const cvt = new Float32Array(1), cvtBits = new Uint32Array(cvt.buffer);
// Round-to-nearest-even, identical to ggml_compute_fp32_to_fp16 for finite values.
export function floatToHalf(x) {
  cvt[0] = x; const f = cvtBits[0], sign = (f >>> 16) & 0x8000;
  let e = ((f >>> 23) & 0xff) - 127 + 15, m = f & 0x7fffff;
  if (((f >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000; const shift = 14 - e, half = 1 << (shift - 1), rest = m & ((1 << shift) - 1);
    let r = m >>> shift; if (rest > half || (rest === half && (r & 1))) r++; return sign | r;
  }
  let r = (e << 10) | (m >>> 13); const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (r & 1))) r++;
  return sign | r;
}
export function bf16ToFloat(src, dst = new Float32Array(src.length / 2)) {
  const u = new Uint32Array(dst.buffer, dst.byteOffset, dst.length);
  for (let i = 0; i < dst.length; i++) u[i] = src.readUInt16LE(i * 2) << 16;
  return dst;
}
// Round-to-nearest-even, as ggml_compute_fp32_to_bf16.
export function floatToBf16(src, dst = Buffer.alloc(src.length * 2)) {
  const u = new Uint32Array(src.buffer, src.byteOffset, src.length);
  for (let i = 0; i < src.length; i++) {
    const v = u[i];
    dst.writeUInt16LE((v & 0x7fffffff) > 0x7f800000 ? (v >>> 16) | 64 : (v + (0x7fff + ((v >>> 16) & 1))) >>> 16, i * 2);
  }
  return dst;
}
export function dequantQ8_0(src, dst) {
  for (let b = 0, o = 0; o < dst.length; b += 34) {
    const d = f16[src.readUInt16LE(b)];
    for (let i = 0; i < 32; i++) dst[o++] = d * src.readInt8(b + 2 + i);
  }
  return dst;
}
function scaleMin(j, q, o) {
  if (j < 4) return [q[o + j] & 63, q[o + j + 4] & 63];
  return [(q[o + j + 4] & 0xf) | ((q[o + j - 4] >> 6) << 4), (q[o + j + 4] >> 4) | ((q[o + j] >> 6) << 4)];
}
export function dequantQ4_K(src, dst) {
  for (let b = 0, o = 0; o < dst.length; b += 144) {
    const d = f16[src.readUInt16LE(b)], dmin = f16[src.readUInt16LE(b + 2)];
    for (let j = 0; j < 256; j += 64) {
      const [s1, m1] = scaleMin(j / 32, src, b + 4), [s2, m2] = scaleMin(j / 32 + 1, src, b + 4);
      const q = b + 16 + j / 2;
      for (let l = 0; l < 32; l++) dst[o + j + l] = d * s1 * (src[q + l] & 0xf) - dmin * m1;
      for (let l = 0; l < 32; l++) dst[o + j + 32 + l] = d * s2 * (src[q + l] >> 4) - dmin * m2;
    }
    o += 256;
  }
  return dst;
}

// Port of ggml's quantize_row_q4_K_ref (no importance matrix), float32 arithmetic via Math.fround.
const F = Math.fround;
const nearestInt = x => { cvt[0] = F(x) + 12582912; return (cvtBits[0] & 0x007fffff) - 0x00400000; };
function makeQkx2(n, nmax, x, xo, w, L, lo, Laux) {
  let min = x[xo], max = x[xo], sumW = w[0], sumX = F(sumW * x[xo]);
  for (let i = 1; i < n; i++) { const v = x[xo + i]; if (v < min) min = v; if (v > max) max = v; sumW = F(sumW + w[i]); sumX = F(sumX + F(w[i] * v)); }
  if (min > 0) min = 0;
  if (max === min) { for (let i = 0; i < n; i++) L[lo + i] = 0; return [0, -min]; }
  let iscale = F(nmax / F(max - min)), scale = F(1 / iscale), bestMad = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.max(0, Math.min(nmax, nearestInt(F(iscale * F(x[xo + i] - min))))); L[lo + i] = l;
    const diff = F(F(F(scale * l) + min) - x[xo + i]); bestMad = F(bestMad + F(w[i] * F(diff * diff)));
  }
  for (let is = 0; is <= 20; is++) {
    iscale = F(F(F(-1 + F(0.1 * is)) + nmax) / F(max - min));
    let sumL = 0, sumL2 = 0, sumXL = 0;
    for (let i = 0; i < n; i++) {
      const l = Math.max(0, Math.min(nmax, nearestInt(F(iscale * F(x[xo + i] - min))))); Laux[i] = l;
      sumL = F(sumL + F(w[i] * l)); sumL2 = F(sumL2 + F(F(w[i] * l) * l)); sumXL = F(sumXL + F(F(w[i] * l) * x[xo + i]));
    }
    const D = F(F(sumW * sumL2) - F(sumL * sumL));
    if (D > 0) {
      let thisScale = F(F(F(sumW * sumXL) - F(sumX * sumL)) / D), thisMin = F(F(F(sumL2 * sumX) - F(sumL * sumXL)) / D);
      if (thisMin > 0) { thisMin = 0; thisScale = F(sumXL / sumL2); }
      let mad = 0;
      for (let i = 0; i < n; i++) { const diff = F(F(F(thisScale * Laux[i]) + thisMin) - x[xo + i]); mad = F(mad + F(w[i] * F(diff * diff))); }
      if (mad < bestMad) { for (let i = 0; i < n; i++) L[lo + i] = Laux[i]; bestMad = mad; scale = thisScale; min = thisMin; }
    }
  }
  return [scale, -min];
}
export function quantQ4_K(x, dst = Buffer.alloc(x.length / 256 * 144)) {
  const L = new Uint8Array(256), Laux = new Uint8Array(32), w = new Float32Array(32), scales = new Float32Array(8), mins = new Float32Array(8);
  for (let b = 0, xo = 0; xo < x.length; b += 144, xo += 256) {
    let maxScale = 0, maxMin = 0;
    for (let j = 0; j < 8; j++) {
      let sumX2 = 0; for (let l = 0; l < 32; l++) { const v = x[xo + 32 * j + l]; sumX2 = F(sumX2 + F(v * v)); }
      const av = F(Math.sqrt(F(sumX2 / 32)));
      for (let l = 0; l < 32; l++) w[l] = F(av + Math.abs(x[xo + 32 * j + l]));
      [scales[j], mins[j]] = makeQkx2(32, 15, x, xo + 32 * j, w, L, 32 * j, Laux);
      if (scales[j] > maxScale) maxScale = scales[j];
      if (mins[j] > maxMin) maxMin = mins[j];
    }
    const invScale = maxScale > 0 ? F(63 / maxScale) : 0, invMin = maxMin > 0 ? F(63 / maxMin) : 0;
    dst.fill(0, b + 4, b + 16);
    for (let j = 0; j < 8; j++) {
      const ls = Math.min(63, nearestInt(F(invScale * scales[j])) & 0xff), lm = Math.min(63, nearestInt(F(invMin * mins[j])) & 0xff);
      if (j < 4) { dst[b + 4 + j] = ls; dst[b + 4 + j + 4] = lm; }
      else { dst[b + 4 + j + 4] = (ls & 0xf) | ((lm & 0xf) << 4); dst[b + 4 + j - 4] |= (ls >> 4) << 6; dst[b + 4 + j] |= (lm >> 4) << 6; }
    }
    const dh = floatToHalf(F(maxScale / 63)), mh = floatToHalf(F(maxMin / 63));
    dst.writeUInt16LE(dh, b); dst.writeUInt16LE(mh, b + 2);
    for (let j = 0; j < 8; j++) {
      const [sc, m] = scaleMin(j, dst, b + 4), d = F(f16[dh] * sc);
      if (!d) continue;
      const dm = F(f16[mh] * m);
      for (let i = 0; i < 32; i++) L[32 * j + i] = Math.max(0, Math.min(15, nearestInt(F(F(x[xo + 32 * j + i] + dm) / d))));
    }
    for (let j = 0, q = b + 16; j < 256; j += 64, q += 32) for (let l = 0; l < 32; l++) dst[q + l] = L[j + l] | (L[j + l + 32] << 4);
  }
  return dst;
}
