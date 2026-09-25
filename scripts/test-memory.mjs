import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {engineArgs,chooseMode,engineFeatures} from './engine-manager.mjs';
import {enginePayload,validate,vaeTiling,UNTILED_VAE_PIXELS} from './core.mjs';
import {diagnoseFailure,logOffset,recentLog} from './engine-diagnostics.mjs';
const h={cpuAvailable:true,gpus:[{id:'CUDA0',runtime:'runtime-v0.2.1'}]}, vulkan={cpuAvailable:true,gpus:[{id:'Vulkan0',runtime:'runtime-vulkan-v0.2.1'}]};
const unmerged=s=>({...engineFeatures(s),merged:false});
// Weight placement: never streamed from disk on each step (58 s vs 30 s per 1024 px image on GPU).
for(const mode of ['cpu','gpu','hybrid']){
  const s=chooseMode(mode,h),a=engineArgs(s,0,7882,unmerged(s));
  assert.ok(!a.includes('--params-backend'),'no forced disk placement');
  assert.ok(a.includes(mode==='cpu'?'--mmap':'--offload-to-cpu'));
  assert.ok(a.includes('--vae-conv-direct'));
  assert.equal(a[a.indexOf('--lora-apply-mode')+1],'at_runtime');
}
assert.equal(chooseMode('hybrid',h).backend,'all=cpu,diffusion=CUDA0,vae=CUDA0');
assert.ok(engineArgs(chooseMode('gpu',h),0,7882,{...unmerged(chooseMode('gpu',h)),attention:'sage'}).includes('--sage-attn'));
assert.equal(engineFeatures(chooseMode('gpu',h),false).attention,'flash');
const vk=chooseMode('gpu',vulkan);assert.equal(engineFeatures(vk).attention,'flash');assert.equal(engineFeatures(vk).convDirect,true);
const merged=engineArgs(chooseMode('gpu',h),0,7882,{...unmerged(chooseMode('gpu',h)),merged:true});
if(merged.some(x=>x.endsWith('merged-Q4_K.gguf')))assert.ok(!merged.includes('--lora-apply-mode'),'merged model must not load the LoRA again');
// Payload: the merged model must not receive the LoRA a second time.
const p=validate({prompt:'teapot',width:1024,height:1024});
assert.equal(enginePayload(p,0,{merged:true}).lora.length,0);
assert.equal(enginePayload(p,0,{}).lora.length,1);
assert.equal(vaeTiling(1024,1024,{convDirect:true,mode:'gpu'}).enabled,false);
assert.equal(vaeTiling(2048,2048,{convDirect:true,mode:'gpu'}).enabled,true);
assert.equal(vaeTiling(1024,1024,{convDirect:true,mode:'cpu'}).enabled,true);
assert.equal(vaeTiling(1024,1024,{}).enabled,true);
assert.ok(1344*768<=UNTILED_VAE_PIXELS);
assert.equal(validate({prompt:'x'}).fastAttention,true);assert.equal(validate({prompt:'x',fastAttention:false}).fastAttention,false);assert.throws(()=>validate({prompt:'x',fastAttention:'no'}));
const oom='[ERROR] ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 177210368';
assert.equal(diagnoseFailure('generate_image returned no results',oom).code,'RAM_ALLOCATION_FAILED');
assert.equal(diagnoseFailure('failed','CUDA error: out of memory').code,'GPU_ALLOCATION_FAILED');
assert.equal(diagnoseFailure('failed','file missing').code,'ENGINE_FAILED');
assert.equal(diagnoseFailure('failed','[ERROR] ggml - alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1072015360').code,'GPU_ALLOCATION_FAILED');
await mkdir('qa',{recursive:true});const dir=await mkdtemp(resolve('qa','memory-log-'));const log=resolve(dir,'err.log');await writeFile(log,oom+'\n');const offset=await logOffset(log);await appendFile(log,'model file missing\n');assert.equal(diagnoseFailure('failed',await recentLog(offset,log)).code,'ENGINE_FAILED');
console.log('PASS weights in RAM/mmap (not per-step disk), hybrid VAE on GPU, attention/VAE options, merged payload without LoRA, RAM/GPU diagnosis.');
