import assert from 'node:assert/strict';
import { validate, turboSigmas, enginePayload, MODEL } from './core.mjs';
const valid = {prompt:'A fox',width:512,height:512,steps:4,seed:0,count:1};
assert.equal(validate(valid).seed,0);
for (const bad of [{width:513},{steps:0},{steps:41},{seed:-2},{count:9},{refs:['data:image/png;base64,YQ==']},{prompt:''},{seed:2147483647,count:2}]) assert.throws(()=>validate({...valid,...bad}));
assert.equal(validate({...valid,count:8}).count,8);
assert.equal(enginePayload(validate({...valid,count:8,seed:42}),7).seed,49);
const schedule = turboSigmas(512,512,4);
// Independent analytical expectation: mu=.5+(1024-256)*.4/(8192-256).
const mu=0.5387096774193548;
assert.equal(schedule.length,5);assert.equal(schedule[0],1);assert.equal(schedule[4],0);
for(let i=0;i<4;i++){ const t=(4-i)/4; assert.ok(Math.abs(schedule[i]-1/(1+(1/t-1)*Math.exp(-mu)))<1e-12); }
assert.ok(turboSigmas(1024,1024,4)[1]>schedule[1]);
assert.equal(validate({prompt:'test'}).steps,6);
const expectedRaw=[1,0.9375,0.875,0.75,0.5,0.25];
assert.equal(turboSigmas(512,512,6).length,7);
for(let i=0;i<6;i++)assert.ok(Math.abs(turboSigmas(512,512,6)[i]-1/(1+(1/expectedRaw[i]-1)*Math.exp(-mu)))<1e-12);
for(const n of [5,6,7,12,40])assert.deepEqual(turboSigmas(512,512,n).slice(-4),turboSigmas(512,512,4).slice(-4));
assert.equal(enginePayload(validate(valid)).lora[0].path,MODEL.runtimeLora);
assert.equal(enginePayload(validate(valid)).lora[0].multiplier,1);
assert.equal(enginePayload(validate(valid)).sample_params.guidance.txt_cfg,1);
assert.equal(enginePayload(validate(valid)).sample_params.sample_steps,4);
assert.equal(enginePayload(validate({...valid,seed:42,count:2}),1).seed,43);
const base='http://127.0.0.1:7871';
let r=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.com'},body:JSON.stringify(valid)});assert.equal(r.status,403);
r=await fetch(base+'/api/status');assert.equal((await r.json()).app,'qwen-turbo-local');
console.log('PASS: input validation, seed 0, batch seeds, Turbo scheduler, CFG, origin isolation and live status.');
