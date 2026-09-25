import {stat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
const log=resolve(import.meta.dirname,'../logs/engine.err.log');
export async function logOffset(file=log){try{return (await stat(file)).size;}catch{return 0;}}
export async function recentLog(offset,file=log){
  let f;try{f=await open(file,'r');const {size}=await f.stat();const start=Math.max(offset<=size?offset:0,size-65536);const b=Buffer.alloc(size-start);await f.read(b,0,b.length,start);return b.toString();}catch{return '';}finally{await f?.close();}
}
export function diagnoseFailure(message,logText){
  if(/ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate|bad_alloc|not enough (?:system )?memory|paging file is too small/i.test(logText))return {code:'RAM_ALLOCATION_FAILED',message:'No quedó suficiente memoria RAM o memoria virtual de Windows para completar la imagen. Cierra otras aplicaciones pesadas y vuelve a intentarlo; si persiste, reduce el tamaño.'};
  if(/cudaMalloc.*failed|CUDA.*out of memory|Vulkan.*out of.*memory|device.*out of memory|failed to allocate (?:CUDA|Vulkan)\d* buffer/i.test(logText))return {code:'GPU_ALLOCATION_FAILED',message:'La GPU no tuvo memoria suficiente para completar la imagen. Prueba un tamaño menor, el modo CPU + GPU (texto en CPU) o CPU.'};
  return {code:'ENGINE_FAILED',message:(/generate_image returned no results/i.test(message)?'El motor no pudo completar la imagen.':message)+' Consulta logs/engine.err.log para ver la causa.'};
}
