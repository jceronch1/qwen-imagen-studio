'use strict';
const $ = s => document.querySelector(s);
const state = { refs: [], gallery: [], selected: null, job: null, ready: false, polling: false, deleting: false, checked: new Set(), hardware: null };
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `Error ${r.status}`); return data;
}
function notice(message, error = false) { $('#notice').hidden = false; $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function settings() { return { prompt: $('#prompt').value, width: +$('#width').value, height: +$('#height').value, steps: +$('#steps').value, count: +$('#count').value, seed: +$('#seed').value, compute: $('#compute').value, threads: +$('#threads').value, transparent: $('#transparent').checked, fastAttention: $('#fastAttention').checked }; }
// Loads the models for the selected device while the prompt is written, so the first image starts at once.
let warmTimer = null, warmedKey = null, pendingKey = null;
function warmEngine() {
  const s = settings(), key = JSON.stringify([s.compute, s.threads, s.fastAttention]);
  if (state.job || !state.hardware || key === warmedKey || key === pendingKey || !Number.isInteger(s.threads) || s.threads < 0 || s.threads > 128) return;
  clearTimeout(warmTimer); pendingKey = key;
  warmTimer = setTimeout(() => {
    pendingKey = null;
    if (state.job || JSON.stringify([$('#compute').value, +$('#threads').value, $('#fastAttention').checked]) !== key) return;
    warmedKey = key;
    api('/api/engine/warmup', { method: 'POST', body: JSON.stringify({ compute: s.compute, threads: s.threads, fastAttention: s.fastAttention }) }).catch(() => { warmedKey = null; });
  }, 700);
}
function persist() { try { localStorage.setItem('turbo.settings', JSON.stringify(settings())); } catch {} }
function refreshForm() {
  const s = settings(); $('#chars').textContent = `${s.prompt.length}/6000`;
  $('#canvasSize').textContent = `${s.width} × ${s.height}`; $('#megapixels').textContent = `${(s.width*s.height/1e6).toFixed(2)} MP`;
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', +b.dataset.w === s.width && +b.dataset.h === s.height));
  $('#stepsHint').textContent = s.steps === 6 ? '6 pasos · configuración recomendada para Viggle v0.2.1.' : 'Modo experimental: usa 6 pasos para v0.2.1. Se conservan los nodos de entrenamiento al añadir pasos; menos de 4 no está recomendado.';
  $('#generate').disabled = !!state.job || !state.ready;
  $('#compute').disabled=!!state.job;$('#fastAttention').disabled=!!state.job;
  $('#computeHint').textContent={auto:'Automático usa GPU con una tarjeta dedicada, CPU + GPU con una GPU integrada y CPU si no hay GPU compatible.',cpu:'Todo el cálculo se realiza en CPU. Puede tardar varios minutos o más. Empieza con 512 × 512 y 6 pasos. 0 hilos = automático.',gpu:'Todo el cálculo se realiza en la GPU. Los pesos esperan en RAM y cada modelo pasa a la VRAM cuando se necesita.',hybrid:'La CPU interpreta el texto y las referencias; la GPU genera y decodifica la imagen. Para GPU integrada o con poca VRAM; con una GPU dedicada de 8 GB, GPU es algo más rápido.'}[$('#compute').value]+' Al cambiar el modo, los modelos se cargan de nuevo en segundo plano.';
  syncSelection();
  document.querySelectorAll('.gallery-delete, #deleteAll, #delete').forEach(b=>b.disabled=!!state.job||state.deleting||!state.gallery.length);
  persist(); warmEngine();
}
function setSettings(s) { for (const key of ['prompt','width','height','steps','count','seed','compute','threads']) if (s[key] !== undefined) $(`#${key}`).value = s[key]; $('#transparent').checked = s.transparent === true; if (typeof s.fastAttention === 'boolean') $('#fastAttention').checked = s.fastAttention; refreshForm(); }
function renderRefs() {
  $('#refs').replaceChildren(); $('#refCount').textContent = `${state.refs.length} / 2`; $('#refHint').hidden = !state.refs.length; $('#addSecond').hidden = state.refs.length !== 1;
  state.refs.forEach((src,i) => {
    const div = document.createElement('div'); div.className = 'ref';
    const img = document.createElement('img'); img.src = src; img.alt = `Referencia ${i+1}`;
    const nav = document.createElement('nav'); const label = document.createElement('span'); label.textContent = `Imagen ${i+1}`; nav.append(label);
    if (i) { const prev = document.createElement('button'); prev.type='button'; prev.textContent='←'; prev.title='Mover referencia a la izquierda'; prev.onclick=()=>{[state.refs[i-1],state.refs[i]]=[state.refs[i],state.refs[i-1]];renderRefs();}; nav.append(prev); }
    const remove = document.createElement('button'); remove.type='button'; remove.textContent='×'; remove.setAttribute('aria-label',`Quitar referencia ${i+1}`); remove.onclick=()=>{state.refs.splice(i,1);renderRefs();}; nav.append(remove);
    div.append(img,nav); $('#refs').append(div);
  });
}
async function addFiles(files) {
  try {
    for (const file of files) {
      if (state.refs.length >= 2) throw new Error('El modelo admite un máximo de 2 referencias.');
      if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 8*1024*1024) throw new Error('Usa PNG, JPG o WebP de hasta 8 MB.');
      // Decode and normalize uploads; limits decoded dimensions before inference.
      const bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 40000000) { bitmap.close(); throw new Error('La referencia excede 40 megapíxeles. Redúcela antes de subirla.'); }
      const scale = Math.min(1, 1536 / Math.max(bitmap.width,bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width*scale); canvas.height = Math.round(bitmap.height*scale);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
      state.refs.push(canvas.toDataURL('image/png')); renderRefs();
    }
  } catch(e) { notice(e.message,true); }
  $('#files').value='';
}
$('#addSecond').onclick=()=>$('#files').click();
$('#files').onchange = e => addFiles(e.target.files);
const dz=$('#dropzone'); for(const event of ['dragenter','dragover']) dz.addEventListener(event,e=>{e.preventDefault();dz.classList.add('drag');});
for(const event of ['dragleave','drop']) dz.addEventListener(event,e=>{e.preventDefault();dz.classList.remove('drag');});
dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));
document.querySelectorAll('.preset').forEach(b=>b.onclick=()=>{ $('#width').value=b.dataset.w;$('#height').value=b.dataset.h;refreshForm(); });
$('#swap').onclick=()=>{const w=$('#width').value;$('#width').value=$('#height').value;$('#height').value=w;refreshForm();};
$('#form').addEventListener('input',e=>{if(!e.target.matches('[data-number]'))refreshForm();});
$('#random').onclick=()=>{$('#seed').value=crypto.getRandomValues(new Uint32Array(1))[0]%2147483640;refreshForm();};
$('#recommended').onclick=()=>{$('#steps').value=6;refreshForm();};
const ideas = ['An elegant ceramic teapot shaped like a tiny house, lavender glaze, soft morning sunlight, minimalist product photography, warm cream background.', 'Un jardín botánico dentro de una estación espacial, helechos gigantes, ventanas hacia Saturno, fotografía cinematográfica, luz dorada.', 'An editorial photograph of a red fox in a snowy forest at sunrise, soft mist, detailed fur, warm backlight, natural colors.','Un cartel tipográfico que dice "IMAGINA", formas de papel tridimensionales en tonos lavanda y coral, composición editorial limpia.'];
let ideaIndex=0;$('#inspire').onclick=()=>{$('#prompt').value=ideas[ideaIndex++%ideas.length];refreshForm();};
$('#theme').onclick=()=>{document.body.classList.toggle('dark');try{localStorage.setItem('turbo.theme',document.body.classList.contains('dark')?'dark':'light');}catch{}};
function selectImage(item) {
  state.selected=item; $('#result').src=item.src;$('#result').hidden=false;$('#empty').hidden=true;$('#resultInfo').hidden=false;
  $('#resultTitle').textContent=item.prompt.length>85?item.prompt.slice(0,85)+'…':item.prompt;
  $('#resultMeta').textContent=`${item.width} × ${item.height} · ${item.steps} pasos · Semilla ${item.seed} · ${item.refsCount||0} referencias · v${item.modelVersion||'0.1'}${item.computeUsed?' · '+({cpu:'CPU',gpu:'GPU',hybrid:'CPU + GPU',external:'Motor externo'}[item.computeUsed]||item.computeUsed):''}${item.loraApplication==='merged'?' · LoRA fusionado':''}${item.seconds?' · '+item.seconds+' s':''}`;
  $('#download').href=item.src;$('#download').download=`qwen-imagen-${item.seed}.png`;
  $('#metadata').href=`/outputs/${item.id}.json`;$('#metadata').download=`qwen-imagen-${item.seed}.json`;
  document.querySelectorAll('.thumb').forEach(b=>b.classList.toggle('selected',b.dataset.id===item.id));
}
async function loadGallery(selectLatest=false) {
  state.gallery=await api('/api/gallery');$('#gallery').replaceChildren();$('#galleryCount').textContent=state.gallery.length;$('#galleryEmpty').hidden=!!state.gallery.length;
  state.gallery.forEach(item=>{
    const card=document.createElement('article');card.className='gallery-card';
    const b=document.createElement('button');b.className='thumb';b.dataset.id=item.id;b.title=item.prompt;
    const img=document.createElement('img');img.src=item.src;img.alt=item.prompt;img.loading='lazy';
    const div=document.createElement('div');div.textContent=item.width+' × '+item.height;
    const meta=document.createElement('span');meta.textContent=item.steps+' pasos · '+item.seed;div.append(meta);b.append(img,div);b.onclick=()=>selectImage(item);
    const remove=document.createElement('button');remove.className='gallery-delete';remove.textContent='Eliminar';remove.setAttribute('aria-label','Eliminar imagen con semilla '+item.seed);remove.onclick=()=>deleteImages(item);
    const label=document.createElement('label');label.className='image-selection';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.imageId=item.id;checkbox.checked=state.checked.has(item.id);checkbox.setAttribute('aria-label','Seleccionar imagen con semilla '+item.seed);checkbox.onchange=()=>{if(checkbox.checked)state.checked.add(item.id);else state.checked.delete(item.id);syncSelection();};
    label.append(checkbox,document.createTextNode('Seleccionar'));card.append(label,b,remove);$('#gallery').append(card);
  });
  state.checked=new Set([...state.checked].filter(id=>state.gallery.some(item=>item.id===id)));
  if(state.selected&&!state.gallery.some(x=>x.id===state.selected.id))state.selected=null;
  if(!state.gallery.length){$('#result').hidden=true;$('#empty').hidden=false;$('#resultInfo').hidden=true;}
  refreshForm();
  if(state.gallery.length&&(selectLatest||!state.selected))selectImage(state.gallery[0]);
  else if(state.selected)selectImage(state.selected);
}
$('#reuse').onclick=async()=>{try{const item=state.selected;const refs=await api(`/api/references/${item.id}`);setSettings(item);state.refs=refs.slice(0,2);renderRefs();notice('Ajustes, semilla y referencias restaurados. Puedes repetir o modificar la creación.');$('#prompt').focus();}catch(e){notice(e.message,true);}};
$('#useRef').onclick=async()=>{try{if(state.refs.length>=2)throw new Error('Quita una referencia antes de añadir otra.');const r=await fetch(state.selected.src);await addFiles([new File([await r.blob()],'referencia.png',{type:'image/png'})]);notice('Imagen añadida a las referencias. Describe el cambio que quieres hacer.');}catch(e){notice(e.message,true);}};
async function deleteImages(item=null, ids=null) {
  if(state.job||state.deleting)return;
  const message=ids?'¿Eliminar las '+ids.length+' imágenes seleccionadas?':item?'¿Eliminar esta imagen de la biblioteca?':'¿Eliminar las '+state.gallery.length+' imágenes de la biblioteca?';
  if(!confirm(message))return;
  state.deleting=true;refreshForm();
  try{await api(ids?'/api/gallery/selection':item?'/api/gallery/'+item.id:'/api/gallery',{method:'DELETE',...(ids?{body:JSON.stringify({ids})}:{})});await loadGallery();notice(ids?'Imágenes seleccionadas eliminadas.':item?'Imagen eliminada de la biblioteca.':'Biblioteca vaciada.');}
  catch(e){notice(e.message,true);}
  finally{state.deleting=false;refreshForm();}
}
$('#delete').onclick=()=>{if(state.selected)deleteImages(state.selected);};
$('#deleteAll').onclick=()=>deleteImages();
$('#deleteSelected').onclick=()=>{if(state.checked.size)deleteImages(null,[...state.checked]);};
$('#selectAll').onchange=e=>{state.checked=new Set(e.target.checked?state.gallery.map(item=>item.id):[]);syncSelection();};
function syncSelection(){
  const blocked=!!state.job||state.deleting;
  $('#selectionCount').textContent=state.checked.size+' seleccionadas';
  $('#deleteSelected').disabled=blocked||!state.checked.size;
  const all=$('#selectAll');all.disabled=blocked||!state.gallery.length;all.checked=!!state.gallery.length&&state.checked.size===state.gallery.length;all.indeterminate=state.checked.size>0&&state.checked.size<state.gallery.length;
  document.querySelectorAll('[data-image-id]').forEach(box=>{box.checked=state.checked.has(box.dataset.imageId);box.disabled=blocked;box.closest('.gallery-card').classList.toggle('checked',box.checked);});
}

function showJob(job) {state.job=job;$('#working').hidden=false;$('#workTitle').textContent=`Creando ${job.current||1} de ${job.total}`;$('#workMessage').textContent=job.message;$('#elapsed').textContent=`${Math.round((Date.now()-job.startedAt)/1000)} s`;$('#cancel').disabled=job.cancelRequested;$('#cancel').textContent=job.cancelRequested?'Esperando a que termine la imagen…':'Detener tras esta imagen';refreshForm();}
async function followJob(id) {
  if(state.polling)return;state.polling=true;
  try{while(true){const job=await api(`/api/jobs/${id}`);showJob(job);if(['completed','failed','cancelled'].includes(job.status)){state.job=null;$('#working').hidden=true;notice(job.message,job.status==='failed');await loadGallery(job.images.length>0);break;}await new Promise(r=>setTimeout(r,400));}}
  catch(e){state.job=null;$('#working').hidden=true;notice(`No se pudo consultar la generación: ${e.message}. Reconectando al motor…`,true);}
  finally{state.polling=false;refreshForm();}
}
$('#form').onsubmit=async e=>{e.preventDefault();if(state.job)return;$('#generate').disabled=true;$('#notice').hidden=true;try{const job=await api('/api/jobs',{method:'POST',body:JSON.stringify({...settings(),refs:state.refs})});showJob(job);void followJob(job.id);}catch(e){notice(e.message,true);refreshForm();}};
$('#cancel').onclick=async()=>{if(!state.job)return;try{const job=await api(`/api/jobs/${state.job.id}/cancel`,{method:'POST',body:'{}'});showJob(job);}catch(e){notice(e.message,true);}};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();if(state.ready&&!state.job)$('#form').requestSubmit();}});
async function status() {let loading=false;try{const s=await api('/api/status');state.ready=s.ready;loading=!!s.compute?.loading;
if(s.compute?.hardware){const h=s.compute.hardware,first=!state.hardware;state.hardware=h;$('#hardwareInfo').textContent=h.cpuName+' · '+h.logicalCores+' hilos · '+h.ramGB+' GB RAM. '+(h.gpus.length?'GPU: '+h.gpus.map(g=>g.name+(g.integrated?' (integrada)':'')).join(', '):'Sin GPU compatible detectada. Puedes generar con CPU.');for(const o of $('#compute').options)o.disabled=!h.modes.includes(o.value);
$('#fastAttention').closest('label').hidden=!h.gpus.some(g=>/^cuda/i.test(g.id));
$('#engineInfo').textContent='Viggle Turbo v0.2.1 · modelo base Q4_K + LoRA r256 '+(h.merged?'fusionado en los pesos (más rápido y con menos VRAM).':'aplicado en tiempo de ejecución. Ejecuta el instalador para fusionarlo y acelerar la generación.')+' Euler con el planificador Turbo, CFG 1 y sin prompt negativo, como requiere este modelo.';
if(first)warmEngine();}
const current=s.compute?.current;$('#status').classList.toggle('ready',s.ready&&!loading);$('#status').lastChild.textContent=s.ready?(loading?' Cargando modelos…':current?' Motor listo · '+({cpu:'CPU',gpu:'GPU',hybrid:'CPU + GPU'}[current.mode]):' Listo para generar'):' Detectando / desconectado';if(s.active&&!state.job){showJob(s.active);void followJob(s.active.id);}}catch{state.ready=false;$('#status').classList.remove('ready');$('#status').lastChild.textContent=' Servidor desconectado';}refreshForm();setTimeout(status,loading?1500:5000);}

const numberPresets={width:[512,768,1024,1152,1344,1536,2048],height:[512,768,864,1024,1152,1344,1536,2048],steps:[4,5,6,7,8,12,20,30,40],threads:[0,2,4,8,12,16,24,32],seed:[-1,0,42,12345,424242]};
const numberLabels={width:'Ancho',height:'Alto',steps:'Pasos',seed:'Semilla',threads:'Hilos de CPU'};
function closeNumberMenus(){document.querySelectorAll('.number-options').forEach(menu=>menu.hidden=true);document.querySelectorAll('.number-combo input').forEach(input=>input.setAttribute('aria-expanded','false'));}
for(const [key,values] of Object.entries(numberPresets)){
  const input=$('#'+key), wrapper=document.createElement('div');wrapper.className='number-combo';input.before(wrapper);wrapper.append(input);
  input.setAttribute('role','combobox');input.setAttribute('aria-label',numberLabels[key]);input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',key+'-options');input.setAttribute('aria-autocomplete','list');
  const toggle=document.createElement('button');toggle.type='button';toggle.className='number-toggle';toggle.textContent='⌄';toggle.setAttribute('aria-label','Opciones de '+numberLabels[key].toLowerCase());
  const menu=document.createElement('div');menu.id=key+'-options';menu.className='number-options';menu.role='listbox';menu.setAttribute('aria-label','Valores de '+numberLabels[key].toLowerCase());menu.hidden=true;
  function open(){closeNumberMenus();menu.hidden=false;input.setAttribute('aria-expanded','true');menu.querySelectorAll('[role=option]').forEach(option=>option.setAttribute('aria-selected',String(option.dataset.value===input.value)));}
  toggle.onclick=()=>{if(menu.hidden)open();else closeNumberMenus();};
  input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();open();menu.firstElementChild.focus();}if(e.key==='Escape')closeNumberMenus();});
  input.addEventListener('input',closeNumberMenus);
  for(const n of values){const option=document.createElement('button');option.type='button';option.role='option';option.dataset.value=n;option.textContent=key==='threads'?(n===0?'Automático (0)':n+' hilos'):key==='seed'?(n===-1?'Aleatoria (−1)':'Semilla '+n):key==='steps'?(n===6?'6 · Turbo v0.2.1':n+' pasos'):n+' px';option.onclick=()=>{input.value=n;closeNumberMenus();input.focus();refreshForm();};menu.append(option);}
  menu.addEventListener('keydown',e=>{const options=[...menu.children],i=options.indexOf(document.activeElement);if(e.key==='Escape'){closeNumberMenus();input.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();options[(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();}});
  wrapper.append(toggle,menu);
}
document.addEventListener('click',e=>{if(!e.target.closest('.number-combo'))closeNumberMenus();});

try{if(localStorage.getItem('turbo.theme')==='dark')document.body.classList.add('dark');const saved=JSON.parse(localStorage.getItem('turbo.settings')||'null');if(saved)setSettings(saved);}catch{}
try{if(localStorage.getItem('turbo.modelVersion')!=='0.2.1'){$('#steps').value=6;localStorage.setItem('turbo.modelVersion','0.2.1');}}catch{}
refreshForm();loadGallery().catch(e=>notice(e.message,true));status();
