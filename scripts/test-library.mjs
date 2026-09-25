import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
await mkdir(resolve(root,'qa'),{recursive:true});
const dir=await mkdtemp(resolve(root,'qa','batch-selection-'));
const png=(await readFile(resolve(root,'scripts','fixtures','muestra.png'))).toString('base64');
const seeds=[];
// Simulated inference: tests application batching and deletion, not model quality.
const engine=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('capabilities')) return res.end(JSON.stringify({supported_modes:['img_gen']}));
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;seeds.push(JSON.parse(raw).seed);return res.end(JSON.stringify({id:'fixture-'+seeds.length}));}
  res.end(JSON.stringify({status:'completed',result:{images:[{b64_json:png}]}}));
});
await new Promise(r=>engine.listen(7884,'127.0.0.1',r));
const child=spawn(process.execPath,[resolve(root,'scripts/server.mjs')],{cwd:root,env:{...process.env,QWEN_PORT:'7883',QWEN_ENGINE_PORT:'7884',QWEN_OUTPUT_DIR:dir},stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(path,method='GET',body)=>{const r=await fetch('http://127.0.0.1:7883'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
try {
  for(let i=0;i<40;i++){try{await api('/api/status');break;}catch{await pause(250);}}
  const job=await api('/api/jobs','POST',{prompt:'batch fixture',width:512,height:512,steps:4,seed:42,count:8});assert.equal(job.status,202);
  const busy=await api('/api/gallery/selection','DELETE',{ids:['00000000-0000-0000-0000-000000000000']});assert.equal(busy.status,409);
  let final;for(let i=0;i<100;i++){final=(await api('/api/jobs/'+job.data.id)).data;if(final.status==='completed'||final.status==='failed')break;await pause(250);}
  assert.equal(final.status,'completed',final.message);assert.equal(final.images.length,8);assert.deepEqual(seeds,[42,43,44,45,46,47,48,49]);
  assert.equal((await api('/api/jobs','POST',{prompt:'invalid',count:9})).status,400);
  const before=(await api('/api/gallery')).data;
  for(const ids of [[],['../bad'],['00000000-0000-0000-0000-000000000000']]){const response=await api('/api/gallery/selection','DELETE',{ids});assert.ok([400,409].includes(response.status));assert.equal((await api('/api/gallery')).data.length,8);}
  const chosen=[before[0].id,before[3].id];const deleted=await api('/api/gallery/selection','DELETE',{ids:chosen});assert.equal(deleted.data.deleted,2);
  const after=(await api('/api/gallery')).data;assert.equal(after.length,6);assert.ok(after.every(x=>!chosen.includes(x.id)));
  assert.equal((await api('/api/gallery/'+after[0].id,'DELETE')).data.deleted,1);
  assert.equal((await api('/api/gallery','DELETE')).data.deleted,5);
  assert.equal((await api('/api/gallery')).data.length,0);
  console.log('PASS: 8 sequential outputs, seeds 42–49, count 9 rejected; selected deletion preserves other images; empty/invalid selection and deletion during generation rejected; individual/all deletion. Inference simulated.');
} finally {child.kill();engine.close();}
