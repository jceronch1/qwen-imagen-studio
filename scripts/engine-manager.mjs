import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { existsSync, openSync, closeSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MODEL } from './core.mjs';
import { mergedModel, presetFor, checkpointDir, loraDir } from './models.mjs';
export { mergedModel };
const exec=promisify(execFile), root=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function parseDevices(stdout,runtime){return stdout.split(/\r?\n/).flatMap(line=>{const m=/^(CPU|CUDA\d+|Vulkan\d+)\t(.+)$/i.exec(line.trim());return m?[{id:m[1],name:m[2],runtime,cpu:m[1].toLowerCase()==='cpu'}]:[];});}
const DEDICATED=/geforce|rtx|quadro|tesla|radeon (rx|pro)|arc(\(tm\))? [ab]\d/i;
export function chooseMode(requested,hardware){
  const gpu=hardware.gpus[0];
  // Integrated GPUs (e.g. Radeon 780M) cannot allocate the 5.4 GB text encoder, but with it on CPU
  // they ran 256 px 2.6x faster than the CPU alone. Dedicated GPUs run everything.
  const mode=requested==='auto'?(!gpu?'cpu':gpu.integrated?'hybrid':'gpu'):requested;
  if(!['cpu','gpu','hybrid'].includes(mode))throw new Error('Modo de cálculo inválido.');
  if(mode!=='cpu'&&!gpu)throw new Error('No hay GPU compatible disponible. Selecciona CPU o Automático.');
  if(mode==='cpu'&&!hardware.cpuAvailable)throw new Error('Falta el motor CPU. Ejecuta el instalador con -Backend cpu.');
  // Hybrid keeps only the text encoder on CPU; the VAE on CPU took minutes per 1024 px image.
  return {mode,runtime:mode==='cpu'?MODEL.runtimeCpu:gpu.runtime,device:mode==='cpu'?'CPU':gpu.id,name:mode==='cpu'?'CPU':gpu.name||'',backend:mode==='cpu'?'cpu':mode==='hybrid'?`all=cpu,diffusion=${gpu.id},vae=${gpu.id}`:gpu.id};
}
// Measured on RTX 4070 Laptop 8 GB, 1024x1024, 6 steps: weights streamed from disk 58 s; weights in RAM 30 s;
// + direct-convolution VAE without tiles 27 s; + merged LoRA (transformer resident in VRAM) see README.
// SageAttention kernels need compute capability 8.0 (RTX 30 or newer); GTX 10xx/16xx and RTX 20xx fail to start with it.
export const SAGE_GPU=/RTX\s*[345]0\d0|RTX\s+A\d{3,4}\b|RTX\s+\d{4}\s+Ada|RTX\s+PRO|\b(A10|A16|A30|A40|A100|H100|H200|L4|L40S?)\b/i;
export function sageCapable(selection){return /^cuda/i.test(selection.device)&&SAGE_GPU.test(selection.name||'');}
export function engineFeatures(selection,fastAttention=true,model='qwen'){
  const qwen=model==='qwen';
  return {
    model,
    merged:qwen&&!!mergedModel(),
    // Benchmarked with Qwen-Image only; SDXL uses flash attention.
    attention:qwen&&fastAttention&&sageCapable(selection)?'sage':'flash',
    // Direct 2D/3D convolutions: VAE decode 2.9x faster on CUDA, 1.6x on Vulkan, equal on CPU, far less memory.
    convDirect:true,
    weights:selection.mode==='cpu'?'mmap':'ram'
  };
}
export function engineArgs(selection,threads,port,features=engineFeatures(selection)){
  if(features.model&&features.model!=='qwen')return sdxlArgs(selection,threads,port,features);
  const merged=features.merged&&mergedModel();
  const args=['--diffusion-model',merged||resolve(root,'models',MODEL.base),'--llm',resolve(root,'models/Qwen3VL-8B-Instruct-Q4_K_M.gguf'),'--llm_vision',resolve(root,'models/mmproj-Qwen3VL-8B-Instruct-F16.gguf'),'--vae',resolve(root,'models/qwen_image_2.1_vae_bf16.safetensors'),'--backend',selection.backend,'--threads',String(threads||-1),'--cfg-scale','1','--sampling-method','euler','--listen-ip','127.0.0.1','--listen-port',String(port),'--log-level','info'];
  if(!merged)args.push('--lora-model-dir',resolve(root,'models/loras'),'--lora-apply-mode','at_runtime');
  args.push(features.attention==='sage'?'--sage-attn':'--diffusion-fa');
  if(features.convDirect)args.push('--vae-conv-direct');
  // CPU reads the weights in place from the OS file cache, as llama.cpp does by default.
  // GPU keeps them in RAM and copies each model to VRAM when it is needed; streaming from disk halved the speed.
  args.push(features.weights==='mmap'?'--mmap':'--offload-to-cpu');
  return args;
}
// SDXL checkpoints are single files (UNet, both CLIP encoders and VAE). Without --vae, sd.cpp scales the
// VAE convolutions so the fp16 SDXL VAE does not overflow. LoRAs change per request, so they apply at runtime.
export function sdxlArgs(selection,threads,port,features){
  const args=['--model',resolve(checkpointDir,presetFor(features.model).file),'--lora-model-dir',loraDir,'--lora-apply-mode','at_runtime','--backend',selection.backend,'--threads',String(threads||-1),'--listen-ip','127.0.0.1','--listen-port',String(port),'--log-level','info','--diffusion-fa'];
  if(features.convDirect)args.push('--vae-conv-direct');
  // On GPU the weights wait in RAM and each block is copied to VRAM when needed: SDXL fp16 (6.9 GB) runs on 4–6 GB cards.
  args.push(features.weights==='mmap'?'--mmap':'--offload-to-cpu');
  return args;
}
export async function assertPortFree(port){
  await new Promise((ok,bad)=>{const probe=createServer();probe.once('error',()=>bad(new Error('El puerto del motor está ocupado por otra instancia. Ciérrala antes de generar.')));probe.listen(port,'127.0.0.1',()=>probe.close(ok));});
}
export class EngineManager {
  constructor(port){this.port=port;this.child=null;this.current=null;this.loading=false;this.error=null;this.hardware=null;this.queue=Promise.resolve();this.detection=this.detect();}
  async detect(){
    const runs=await Promise.all([MODEL.runtimeCpu,MODEL.runtime,MODEL.runtimeVulkan].filter(Boolean).map(async runtime=>{
      const exe=resolve(root,runtime,'sd-server.exe');if(!existsSync(exe))return [];
      try{const {stdout}=await exec(exe,['--list-devices'],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});return parseDevices(stdout,runtime);}catch{return [];}
    }));
    const all=runs.flat(), seen=new Set();
    const gpus=all.filter(d=>!d.cpu).map(d=>({...d,integrated:!DEDICATED.test(d.name)})).sort((a,b)=>{
      const score=d=>(d.integrated?0:10)+(/^cuda/i.test(d.id)?1:0);
      return score(b)-score(a);
    }).filter(d=>{if(seen.has(d.name))return false;seen.add(d.name);return true;});
    this.hardware={cpuName:cpus()[0]?.model||'CPU',logicalCores:cpus().length,ramGB:Math.round(totalmem()/1024**3),cpuAvailable:all.some(d=>d.cpu&&d.runtime===MODEL.runtimeCpu),gpus,modes:['auto',...(all.some(d=>d.cpu&&d.runtime===MODEL.runtimeCpu)?['cpu']:[]),...(gpus.length?['gpu','hybrid']:[])],merged:!!mergedModel(),sage:gpus.some(g=>sageCapable({device:g.id,name:g.name}))};
    return this.hardware;
  }
  snapshot(){return {managed:true,hardware:this.hardware,loading:this.loading,current:this.current,error:this.error,canGenerate:!!this.hardware&&(this.hardware.cpuAvailable||this.hardware.gpus.length>0)};}
  async stop(){const child=this.child;this.child=null;this.current=null;if(child&&child.exitCode===null&&child.signalCode===null){await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('El motor anterior no se detuvo.')),10000);child.once('exit',()=>{clearTimeout(timer);done();});child.kill();});}}
  // Serialized: a warm-up and a job must never start two engines on the same port.
  ensure(requested,threads=0,fastAttention=true,model='qwen'){const run=this.queue.then(()=>this.start(requested,threads,fastAttention,model));this.queue=run.catch(()=>{});return run;}
  // Starts the engine and loads the weights before the first image, while the user writes the prompt.
  warm(requested,threads=0,fastAttention=true,model='qwen'){return this.ensure(requested,threads,fastAttention,model).catch(()=>null);}
  async start(requested,threads,fastAttention,model='qwen'){
    const hardware=await this.detection;const selection=chooseMode(requested,hardware);const features=engineFeatures(selection,fastAttention,model);
    const key=JSON.stringify([selection.mode,selection.device,threads,features]);
    if(this.child&&this.current?.key===key&&this.child.exitCode===null&&this.child.signalCode===null)return this.current;
    this.loading=true;this.error=null;
    try{
      await this.stop();
      await assertPortFree(this.port);
      const exe=resolve(root,selection.runtime,'sd-server.exe'), args=[...engineArgs(selection,threads,this.port,features),'--eager-load'];
      await appendFile(resolve(root,'logs/engine.out.log'),`\n[Image Studio ${new Date().toISOString()}] model=${model} mode=${selection.mode} backend=${selection.backend} threads=${threads} runtime=${selection.runtime} features=${JSON.stringify(features)}\n`);
      const out=openSync(resolve(root,'logs/engine.out.log'),'a'),err=openSync(resolve(root,'logs/engine.err.log'),'a');
      const child=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['ignore',out,err]});closeSync(out);closeSync(err);this.child=child;
      let failure;child.on('error',e=>{failure=e;this.error=e.message;});
      await new Promise((ok,bad)=>{child.once('spawn',ok);child.once('error',bad);});
      await writeFile(resolve(root,'logs/engine.pid'),String(child.pid));
      await writeFile(resolve(root,'logs/engine-process.json'),JSON.stringify({pid:child.pid,executable:exe,owner:process.pid,mode:selection.mode}));
      const deadline=Date.now()+300000;
      while(Date.now()<deadline){
        if(failure||child.exitCode!==null||child.signalCode!==null)throw new Error(`El motor ${selection.mode} no pudo iniciar. Revisa logs/engine.err.log.`);
        try{const r=await fetch(`http://127.0.0.1:${this.port}/sdcpp/v1/capabilities`,{signal:AbortSignal.timeout(1500)});if(r.ok&&(await r.json()).supported_modes?.includes('img_gen')){this.current={...selection,threads,key,...features};return this.current;}}catch{}
        await sleep(250);
      }
      throw new Error('El motor tardó demasiado en iniciar. Revisa los registros.');
    }catch(e){this.error=e.message;await this.stop();throw e;}finally{this.loading=false;}
  }
}
