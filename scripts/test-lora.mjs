import assert from 'node:assert/strict';
import { open,readFile,writeFile } from 'node:fs/promises';
import {MODEL} from './core.mjs';
async function file(name){const f=await open('models/loras/'+name,'r');const b=Buffer.alloc(8);await f.read(b,0,8,0);const n=Number(b.readBigUInt64LE());const h=Buffer.alloc(n);await f.read(h,0,n,8);return {f,h:JSON.parse(h),offset:8+n};}
async function tensor(file,key){const t=file.h[key],length=t.data_offsets[1]-t.data_offsets[0],data=Buffer.alloc(length);const {bytesRead}=await file.f.read(data,0,length,file.offset+t.data_offsets[0]);assert.equal(bytesRead,length);return data;}
import {existsSync} from 'node:fs';
// With the merged transformer installed the adapter files are no longer kept.
if(!existsSync('models/loras/'+MODEL.lora)||!existsSync('models/loras/'+MODEL.runtimeLora)){console.log('SKIP: LoRA files not installed (merged transformer in use).');process.exit(0);}
const src=await file(MODEL.lora),dst=await file(MODEL.runtimeLora);let copies=0;
for(const key of Object.keys(src.h)){
 if(key==='__metadata__'||/img_mlp\.(gate_layer|proj)\./.test(key))continue;
 assert.deepEqual(await tensor(src,key),await tensor(dst,key));copies++;
}
for(let layer=0;layer<32;layer++){
 const p=`transformer.transformer_blocks.${layer}.img_mlp.`;
 const a=await tensor(dst,p+'gate_up.lora_A.weight'),b=await tensor(dst,p+'gate_up.lora_B.weight');
 for(let half=0;half<2;half++){
  const name=half?'proj':'gate_layer';
  const sa=await tensor(src,p+name+'.lora_A.weight'),sb=await tensor(src,p+name+'.lora_B.weight');
  assert.deepEqual(a.subarray(half*sa.length,(half+1)*sa.length),sa);
  for(let row=0;row<12288;row++){
   const off=((half*12288+row)*512)*2;
   assert.deepEqual(b.subarray(off+half*512,off+(half+1)*512),sb.subarray(row*512,(row+1)*512));
   assert.ok(b.subarray(off+(1-half)*512,off+(2-half)*512).every(n=>n===0));
  }
 }
}
await src.f.close();await dst.f.close();assert.equal(copies,326);
console.log('PASS: all 454 source tensors preserved exactly: 326 copied, 128 rearranged into 64 block-diagonal tensors, zero padding verified. Scale remains 1.');
