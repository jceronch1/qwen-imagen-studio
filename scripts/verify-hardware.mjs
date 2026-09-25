import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
await mkdir('qa/hardware-update',{recursive:true});
const base='http://127.0.0.1:7871';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;}
let status;for(let i=0;i<45;i++){status=await api('/api/status');if(status.compute?.hardware)break;await sleep(1000);}assert.ok(status.compute.hardware.cpuAvailable);console.log(JSON.stringify(status.compute.hardware));
const records=[];
for(const compute of ['cpu','gpu','hybrid']){
 const request={prompt:'A small red ceramic teapot on a wooden table, warm window light, still life photograph.',width:256,height:256,steps:6,seed:13579,count:1,compute,threads:8};
 const start=Date.now();let job=await api('/api/jobs',request);console.log('Started',compute,job.id);
 let tick=0;while(!['completed','failed','cancelled'].includes(job.status)){await sleep(2000);job=await api('/api/jobs/'+job.id);if(++tick%15===0)console.log(compute,Math.round((Date.now()-start)/1000)+'s',job.message);}
 assert.equal(job.status,'completed',job.message);assert.equal(job.images[0].computeUsed,compute);
 const bytes=await readFile('outputs/'+job.images[0].id+'.png');assert.equal(bytes.readUInt32BE(16),256);assert.equal(bytes.readUInt32BE(20),256);
 records.push({compute,seconds:(Date.now()-start)/1000,image:job.images[0]});await writeFile('qa/hardware-update/real-results.json',JSON.stringify({hardware:status.compute.hardware,records},null,2));console.log('PASS',compute,records.at(-1).seconds+'s');
}
console.log('PASS real CPU, GPU and hybrid generation and live switching.');
