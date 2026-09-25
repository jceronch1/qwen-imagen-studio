import assert from 'node:assert/strict';
import {parseDevices,chooseMode,engineArgs,assertPortFree} from './engine-manager.mjs';
import {validate} from './core.mjs';
const cpu={cpuAvailable:true,gpus:[]};assert.equal(chooseMode('auto',cpu).mode,'cpu');assert.throws(()=>chooseMode('gpu',cpu));assert.throws(()=>chooseMode('hybrid',cpu));
const both={cpuAvailable:true,gpus:[{id:'CUDA0',runtime:'runtime-v0.2.1'}]};assert.equal(chooseMode('auto',both).mode,'gpu');assert.equal(chooseMode('cpu',both).backend,'cpu');assert.equal(chooseMode('hybrid',both).backend,'all=cpu,diffusion=CUDA0,vae=CUDA0');
const igpu={cpuAvailable:true,gpus:[{id:'Vulkan0',name:'AMD Radeon 780M Graphics',runtime:'runtime-vulkan-v0.2.1',integrated:true}]};assert.equal(chooseMode('auto',igpu).mode,'hybrid');assert.equal(chooseMode('auto',igpu).backend,'all=cpu,diffusion=Vulkan0,vae=Vulkan0');assert.equal(chooseMode('gpu',igpu).mode,'gpu');
assert.equal(parseDevices('log line\nCPU\tRyzen\nCUDA0\tRTX\nVulkan1\tAMD','test').length,3);
const args=engineArgs(chooseMode('cpu',both),8,7999);assert.ok(args.includes('cpu'));assert.ok(!args.includes('--max-vram'));assert.ok(!args.some(x=>x.includes('CUDA')));
for(const bad of [{compute:'bad'},{threads:-1},{threads:129},{threads:1.5}])assert.throws(()=>validate({prompt:'teapot',...bad}));
assert.equal(validate({prompt:'teapot'}).compute,'auto');assert.equal(validate({prompt:'teapot',compute:'cpu',threads:8}).threads,8);
console.log('PASS CPU-only detection, GPU rejection without device, integrated GPU auto-hybrid, hybrid mapping, CPU arguments and request validation.');

const {createServer}=await import('node:net');const blocker=createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const busyPort=blocker.address().port;await assert.rejects(()=>assertPortFree(busyPort),/ocupado/);await new Promise(r=>blocker.close(r));await assertPortFree(busyPort);console.log('PASS: occupied engine port cannot be mistaken for the selected device.');
