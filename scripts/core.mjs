import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODEL_FILE, SAMPLERS, presetFor } from './models.mjs';
export const MODEL = JSON.parse(readFileSync(resolve(import.meta.dirname,'..','model-config.json'),'utf8'));

// The merged transformer must come from the pinned LoRA and from the pinned Q8_0 or Q4_K base.
export { mergedProofValid } from './models.mjs';
export function validate(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object') fail('Solicitud inválida.');
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt || prompt.length > 6000) fail('Escribe una descripción de entre 1 y 6000 caracteres.');
  const integer = (name, min, max, fallback) => {
    const n = Number(input[name] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${name}: debe estar entre ${min} y ${max}.`);
    return n;
  };
  const width = integer('width', 256, 2048, 1024), height = integer('height', 256, 2048, 1024);
  if (width % 32 || height % 32) fail('El ancho y alto deben ser múltiplos de 32.');
  const model = input.model ?? 'qwen';
  if (typeof model !== 'string' || (model !== 'qwen' && !(model.startsWith('sdxl:') && MODEL_FILE.test(model.slice(5))))) fail('Modelo inválido.');
  const sdxl = model !== 'qwen', preset = presetFor(model);
  const steps = integer('steps', 1, sdxl ? 60 : 40, preset.steps), count = integer('count', 1, 8, 1);
  let seed = integer('seed', -1, 2147483647, -1);
  if (seed === -1) seed = randomInt(0, 2147483647 - count);
  if (seed + count - 1 > 2147483647) fail('La semilla del lote excede el máximo permitido.');
  const compute = input.compute ?? 'auto';
  if (!['auto','cpu','gpu','hybrid'].includes(compute)) fail('Selecciona Automático, CPU, GPU o CPU + GPU.');
  const threads = integer('threads', 0, 128, 0);
  const refs = input.refs ?? [];
  if (!Array.isArray(refs) || refs.length > 2) fail('Puedes usar hasta 2 referencias.');
  if (sdxl && refs.length) fail('Este modelo no usa imágenes de referencia. Quítalas o elige Qwen-Image.');
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.length > 12 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(ref)) fail('Referencia inválida. Usa PNG, JPEG o WebP de hasta 8 MB.');
    const bytes = Buffer.from(ref.split(',')[1], 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!png && !jpg && !webp) fail('El contenido de la referencia no es una imagen compatible.');
  }
  if (input.fastAttention !== undefined && typeof input.fastAttention !== 'boolean') fail('fastAttention debe ser verdadero o falso.');
  const params = { model, prompt, width, height, steps, count, seed, refs, compute, threads, transparent: input.transparent === true, fastAttention: input.fastAttention !== false };
  if (!sdxl) return params;
  // SDXL: classifier-free guidance, negative prompt, LoRAs from models/sdxl/loras and the wallpaper pass.
  const negative = input.negativePrompt ?? preset.negative;
  if (typeof negative !== 'string' || negative.length > 2000) fail('El prompt negativo admite hasta 2000 caracteres.');
  const cfg = Number(input.cfg ?? preset.cfg);
  if (!Number.isFinite(cfg) || cfg < 1 || cfg > 15) fail('CFG: debe estar entre 1 y 15.');
  const sampler = input.sampler ?? preset.sampler;
  if (!Object.hasOwn(SAMPLERS, sampler)) fail('Sampler inválido.');
  const loras = input.loras ?? [];
  if (!Array.isArray(loras) || loras.length > 4) fail('Puedes combinar hasta 4 LoRAs.');
  for (const l of loras) if (!l || typeof l.file !== 'string' || !MODEL_FILE.test(l.file) || !Number.isFinite(l.weight) || l.weight < -2 || l.weight > 2) fail('LoRA inválido: nombre de archivo y peso entre -2 y 2.');
  const hires = input.hires === true;
  if (hires && width * height > 1216 * 1216) fail('El modo wallpaper parte de una imagen de ~1 MP (por ejemplo 1344 × 768) y la amplía ×1.5.');
  return { ...params, transparent: false, negativePrompt: negative.trim(), cfg, sampler, loras: loras.map(l => ({ file: l.file, weight: l.weight })), hires, qualityTags: input.qualityTags !== false };
}

// Diffusers QwenImage21 flattens unpatched latents: one token per 16x16 pixels.
// FlowMatchEuler exponential time shift; Turbo requires shift_terminal=null.
// sd.cpp accepts final sigmas directly, without applying the shift a second time.
export function turboSigmas(width, height, steps) {
  const tokens = width * height / 256;
  const mu = 0.5 + (tokens - 256) * (0.9 - 0.5) / (8192 - 256);
  const e = Math.exp(mu);
  // v0.2.1 keeps low-noise training anchors; extra steps split only 1 -> .875.
  const raw = steps === 6 ? MODEL.rawSigmas : steps >= 5
    ? [...Array.from({length:steps-4},(_,i)=>1-i*0.125/(steps-4)),0.875,0.75,0.5,0.25]
    : Array.from({length:steps},(_,i)=>1-i/steps);
  return [...raw.map(t => {
    return e / (e + (1 / t - 1));
  }), 0];
}

// With direct convolutions a whole 1 MP latent decodes at once in 2.6 s instead of 7.8 s with 32x32 tiles.
// It needs about 5.6 GB of VRAM at 1024x1024; larger images keep tiles, and sd.cpp retries with tiles on OOM.
export const UNTILED_VAE_PIXELS = 1024 * 1024;
export function vaeTiling(width, height, engine = {}) {
  if (engine.convDirect && engine.mode !== 'cpu' && width * height <= UNTILED_VAE_PIXELS) return { enabled: false };
  return { enabled: true, tile_size_x: 32, tile_size_y: 32, target_overlap: 0.25 };
}

// engine: features of the running engine (merged transformer, convDirect, mode). Defaults to runtime LoRA.
export function enginePayload(params, index = 0, engine = {}) {
  if (params.model?.startsWith('sdxl:')) return sdxlPayload(params, index, engine);
  return {
    prompt: params.transparent ? `This is an RGBA image with transparency. ${params.prompt}. The image has alpha channel and the background is transparent.` : params.prompt,
    negative_prompt: '', width: params.width, height: params.height,
    seed: params.seed + index, batch_count: 1, ref_images: params.refs,
    // Same as the deprecated increase_ref_index: references are numbered image 1, image 2…
    auto_resize_ref_image: true, ref_image_args: 'ref_index_mode=increase', embed_image_metadata: true,
    lora: engine.merged ? [] : [{path:MODEL.runtimeLora,multiplier:MODEL.loraScale,is_high_noise:false}],
    sample_params: { sample_method: 'euler', sample_steps: params.steps,
      custom_sigmas: turboSigmas(params.width, params.height, params.steps), guidance: { txt_cfg: 1.0 } },
    vae_tiling_params: vaeTiling(params.width, params.height, engine),
    output_format: 'png', output_compression: 100
  };
}

// SDXL renders at ~1 MP; the wallpaper option re-renders the latent at 1.5x (hires fix, as in sd-webui).
export const HIRES = { upscaler: 'Latent', scale: 1.5, denoising_strength: 0.55 };
export function outputSize(params) {
  const k = params.hires ? HIRES.scale : 1;
  return { width: Math.round(params.width * k), height: Math.round(params.height * k) };
}
export function sdxlPayload(params, index = 0, engine = {}) {
  const preset = presetFor(params.model), sampler = SAMPLERS[params.sampler], out = outputSize(params);
  return {
    prompt: (params.qualityTags && preset.prefix && !params.prompt.startsWith(preset.prefix.trim()) ? preset.prefix : '') + params.prompt,
    negative_prompt: params.negativePrompt, width: params.width, height: params.height,
    seed: params.seed + index, batch_count: 1, embed_image_metadata: true,
    lora: params.loras.map(l => ({ path: l.file, multiplier: l.weight, is_high_noise: false })),
    sample_params: { sample_method: sampler.method, ...(sampler.scheduler ? { scheduler: sampler.scheduler } : {}), sample_steps: params.steps, guidance: { txt_cfg: params.cfg } },
    hires: params.hires ? { enabled: true, ...HIRES, steps: Math.max(8, Math.round(params.steps / 2)) } : { enabled: false },
    vae_tiling_params: vaeTiling(out.width, out.height, engine),
    output_format: 'png', output_compression: 100
  };
}
