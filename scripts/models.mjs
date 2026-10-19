import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
// Model catalog: Qwen-Image (fixed files from model-config.json) plus every SDXL checkpoint
// dropped into models/sdxl/checkpoints. Known files (sdxl-models.json) bring their recommended settings.
const root = resolve(import.meta.dirname, '..');
const QWEN = JSON.parse(readFileSync(resolve(root, 'model-config.json'), 'utf8'));
export const SDXL = JSON.parse(readFileSync(resolve(root, 'sdxl-models.json'), 'utf8'));
export const MODEL_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.\- ()]{0,150}\.(safetensors|gguf)$/i;
// Sampler choices shown in the UI; "karras" variants also set the scheduler.
export const SAMPLERS = { euler_a: { method: 'euler_a' }, euler: { method: 'euler' }, 'dpm++2m_karras': { method: 'dpm++2m', scheduler: 'karras' }, 'dpm++2s_a': { method: 'dpm++2s_a' } };

export const checkpointDir = resolve(root, SDXL.checkpointDir), loraDir = resolve(root, SDXL.loraDir);
function files(dir) { try { return readdirSync(dir).filter(f => MODEL_FILE.test(f) && statSync(resolve(dir, f)).isFile()).sort(); } catch { return []; } }

// Transformer with the LoRA fused by scripts/merge-lora.mjs. Without it, the LoRA is applied at runtime.
export function mergedProofValid(proof, model = QWEN) {
  return proof?.output === model.merged && proof.loraSha256 === model.loraSha256 && Number.isInteger(proof.outputBytes)
    && ((!!proof.preciseBaseSha256 && proof.preciseBaseSha256 === model.preciseBaseSha256) || (!!proof.baseSha256 && proof.baseSha256 === model.baseSha256));
}
export function mergedModel() {
  try {
    const proof = JSON.parse(readFileSync(resolve(root, 'models/merged-lora.json'), 'utf8')), file = resolve(root, 'models', QWEN.merged);
    return mergedProofValid(proof) && statSync(file).size === proof.outputBytes ? file : null;
  } catch { return null; }
}
export const QWEN_FILES = ['Qwen3VL-8B-Instruct-Q4_K_M.gguf', 'mmproj-Qwen3VL-8B-Instruct-F16.gguf', 'qwen_image_2.1_vae_bf16.safetensors'];
export function qwenInstalled() {
  const transformer = mergedModel() || (existsSync(resolve(root, 'models', QWEN.base)) && existsSync(resolve(root, 'models/loras', QWEN.runtimeLora)));
  return !!transformer && QWEN_FILES.every(f => existsSync(resolve(root, 'models', f)));
}

export const QWEN_PRESET = { id: 'qwen', family: 'qwen', label: `Qwen-Image 2.1 · Viggle Turbo v${QWEN.version}`, steps: QWEN.recommendedSteps, cfg: 1, sampler: 'euler', refs: true, loras: false, negative: '', prefix: '' };
export function sdxlPreset(file) {
  const known = SDXL.known[file] || {}, d = SDXL.defaults;
  return {
    id: 'sdxl:' + file, family: 'sdxl', file, label: known.label || file.replace(/\.(safetensors|gguf)$/i, '') + ' · SDXL',
    source: known.source || null, license: known.license || null, steps: known.steps ?? d.steps, cfg: known.cfg ?? d.cfg,
    sampler: known.sampler ?? d.sampler, prefix: known.prefix ?? '', negative: known.negative ?? d.negative, ideas: known.ideas || d.ideas || [], refs: false, loras: true
  };
}
// Preset from an id already validated by core.validate; existence is checked by installedModel().
export function presetFor(id) { return id === 'qwen' ? QWEN_PRESET : sdxlPreset(id.slice(5)); }
// Known checkpoints (with recommended settings) first, then the user's own files.
export function listModels() {
  const sdxl = files(checkpointDir).sort((a, b) => (b in SDXL.known) - (a in SDXL.known) || a.localeCompare(b)).map(sdxlPreset);
  return [...(qwenInstalled() ? [QWEN_PRESET] : []), ...sdxl];
}
export function installedModel(id) {
  const model = listModels().find(m => m.id === id);
  if (!model) throw Object.assign(new Error('El modelo seleccionado no está instalado. Ejecuta el instalador o copia el checkpoint en ' + SDXL.checkpointDir + '.'), { status: 400 });
  return model;
}
export function listLoras() { return files(loraDir).map(file => ({ file, name: file.replace(/\.(safetensors|gguf)$/i, '') })); }
// Downloadable checkpoints that are not installed yet, for the hint in the UI.
export function availableDownloads() { const have = new Set(files(checkpointDir)); return Object.entries(SDXL.known).filter(([f]) => !have.has(f)).map(([file, k]) => ({ file, label: k.label, source: k.source, sizeGB: k.sizeGB })); }
