// Exact adapter layout conversion for sd.cpp's fused Qwen21 gate_up base.
// A = [A_gate; A_proj], B = diag(B_gate, B_proj); B*A preserves both deltas.
// No quantization, floating-point arithmetic or merging with base weights.
import { open, rename, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const config=JSON.parse(await readFile(resolve(root,'model-config.json'),'utf8'));
const source=resolve(root,'models/loras',config.lora), target=resolve(root,'models/loras',config.runtimeLora);
async function hash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
assert.equal(await hash(source),config.loraSha256,'Unexpected source LoRA');
try { if(await hash(target)===config.runtimeLoraSha256){console.log('LoRA compatible verificado; no necesita cambios.');process.exit(0);} } catch(error){if(error.code!=='ENOENT')throw error;}
const input=await open(source,'r');
async function read(position,length){const b=Buffer.alloc(length);let n=0;while(n<length){const r=await input.read(b,n,length-n,position+n);assert.ok(r.bytesRead);n+=r.bytesRead;}return b;}
const size=Number((await read(0,8)).readBigUInt64LE());
const header=JSON.parse((await read(8,size)).toString());
const base=8+size, entries=[], consumed=new Set();
const bytes=async key=>{const t=header[key];return read(base+t.data_offsets[0],t.data_offsets[1]-t.data_offsets[0]);};
for(let i=0;i<32;i++){
  const prefix=`transformer.transformer_blocks.${i}.img_mlp.`;
  const keys=['gate_layer.lora_A.weight','proj.lora_A.weight','gate_layer.lora_B.weight','proj.lora_B.weight'].map(k=>prefix+k);
  for(const k of keys){assert.equal(header[k]?.dtype,'BF16');consumed.add(k);}
  const [ga,pa,gb,pb]=keys.map(k=>header[k]);
  assert.deepEqual(ga.shape,[256,4096]);assert.deepEqual(pa.shape,ga.shape);
  assert.deepEqual(gb.shape,[12288,256]);assert.deepEqual(pb.shape,gb.shape);
  entries.push({key:prefix+'gate_up.lora_A.weight',shape:[512,4096],length:512*4096*2,keys:keys.slice(0,2),kind:'down'});
  entries.push({key:prefix+'gate_up.lora_B.weight',shape:[24576,512],length:24576*512*2,keys:keys.slice(2),kind:'up'});
}
for(const [key,t] of Object.entries(header))if(key!=='__metadata__'&&!consumed.has(key))entries.push({key,shape:t.shape,length:t.data_offsets[1]-t.data_offsets[0],keys:[key],kind:'copy',dtype:t.dtype});
assert.equal(consumed.size,128);assert.equal(entries.length,390);
let offset=0;
const outHeader={__metadata__:{format:'pt',source:config.source,revision:config.revision,source_sha256:config.loraSha256,conversion:'Exact BF16 block diagonal gate_up layout for sd.cpp 88411ef; all alpha/rank scales = 1.'}};
for(const e of entries){outHeader[e.key]={dtype:e.dtype||'BF16',shape:e.shape,data_offsets:[offset,offset+e.length]};offset+=e.length;}
let json=JSON.stringify(outHeader);json+=' '.repeat((8-Buffer.byteLength(json)%8)%8);
const head=Buffer.from(json),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(head.length));
const output=await open(target+'.tmp','w');
async function write(b){let n=0;while(n<b.length){const r=await output.write(b,n,b.length-n);assert.ok(r.bytesWritten);n+=r.bytesWritten;}}
try{
  await write(length);await write(head);
  for(const e of entries){
    const parts=await Promise.all(e.keys.map(bytes));let b;
    if(e.kind==='copy')b=parts[0];
    else if(e.kind==='down')b=Buffer.concat(parts);
    else{
      b=Buffer.alloc(e.length);
      for(let half=0;half<2;half++)for(let row=0;row<12288;row++)parts[half].copy(b,((half*12288+row)*512+half*256)*2,row*256*2,(row+1)*256*2);
    }
    assert.equal(b.length,e.length);await write(b);
  }
}finally{await output.close();await input.close();}
assert.equal(await hash(target+'.tmp'),config.runtimeLoraSha256,'Unexpected converted LoRA hash');
await rename(target+'.tmp',target);
const proof={source:config.lora,sourceSha256:config.loraSha256,target:config.runtimeLora,targetSha256:await hash(target),sourceTensors:454,targetTensors:390,fusedPairs:32,scale:1,conversion:'A stacked; B block diagonal, gate first. Original BF16 values copied without arithmetic.'};
await writeFile(resolve(root,'models/lora-compatibility.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof,null,2));
