import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
await mkdir('qa/memory-fix',{recursive:true});
import assert from 'node:assert/strict';
const base='http://127.0.0.1:7871', pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(p,b){const r=await fetch(base+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw Error(JSON.stringify(j));return j;}
let s;for(let i=0;i<45;i++){s=await api('/api/status');if(s.ready)break;await pause(1000);}
const start=Date.now(),errStart=(await stat('logs/engine.err.log')).size;
let job=await api('/api/jobs',{prompt:'Vertical editorial photograph of a traveler seen from behind, standing on a rocky hill above a vast city at sunrise. Layered foreground rocks, winding road, hazy skyline, pale blue and golden sky, cinematic natural light, quiet contemplative composition.',width:768,height:1344,steps:6,count:4,seed:1577662650,compute:'hybrid',threads:0});
console.log('Submitted',job.id);await writeFile('qa/memory-fix/test-job.json',JSON.stringify({id:job.id,errStart,start},null,2));
let tick=0;while(!['completed','failed','cancelled'].includes(job.status)){await pause(2000);job=await api('/api/jobs/'+job.id);if(++tick%15===0)console.log(Math.round((Date.now()-start)/1000)+'s',job.current+'/'+job.total,job.status,job.images.length+' saved');}
await writeFile('qa/memory-fix/result.json',JSON.stringify(job,null,2));console.log(job.status,job.message,job.images.map(i=>({id:i.id,seconds:i.seconds,seed:i.seed})));
assert.equal(job.status,'completed',job.message);assert.equal(job.images.length,4);assert.deepEqual(job.images.map(i=>i.seed),[1577662650,1577662651,1577662652,1577662653]);
for(const i of job.images){const b=await readFile('outputs/'+i.id+'.png');assert.equal(b.readUInt32BE(16),768);assert.equal(b.readUInt32BE(20),1344);}
const err=(await readFile('logs/engine.err.log')).subarray(errStart).toString();await writeFile('qa/memory-fix/engine-test.err.log',err);assert.ok(!/failed to allocate|compute failed|sampling.*failed/i.test(err));console.log('PASS real 4-image batch, 768x1344, hybrid, no allocation errors.');
