const status=document.querySelector('#status'),boot=document.querySelector('#boot'),stop=document.querySelector('#stop');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let frame,active=false,start=0,seq=0,queue=Promise.resolve(),timer,checkpointBusy=false,saveError=null;
const config=await(await fetch('./navigation-record-config.json',{cache:'no-store'})).json();
async function call(cmd,...args){const r=await frame.contentWindow.__BS__.harness.__runSteps([{cmd,args}]);if(!r.ok)throw Error(JSON.stringify(r.error));return r.steps.at(-1).result;}
function persist(kind,data){const record={seq:seq++,kind,t:performance.now()-start,data};queue=queue.then(async()=>{const r=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});if(!r.ok)throw Error('Save HTTP '+r.status);}).catch(e=>{saveError=String(e);status.textContent='Ошибка сохранения: '+e;});return queue;}
async function checkpoint(){if(!active||checkpointBusy)return;checkpointBusy=true;try{const shot=await call('shot');const scene=await call('evalWorker',`const s=System.getInstance(),p=s.process,r=s.services.render;if(!p)return {loaded:false};const m=p.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength),ptr=v.getUint32(0x73619c,true);return {racePointer:ptr,raceState:ptr&&ptr+4<=m.length?v.getUint32(ptr,true):null,moverCounter:v.getUint32(0x78eb4c,true),presentSerial:r.getPresentSerial(),paused:s.isPaused};`);await persist('checkpoint',{scene,shot});}catch(e){await persist('checkpoint-error',String(e));}finally{checkpointBusy=false;}}
boot.onclick=async()=>{boot.disabled=true;try{
 frame=document.createElement('iframe');frame.src='/?game=dev&bs=nfsu-navigation-record';document.querySelector('#guest').append(frame);
 const deadline=Date.now()+90000;while(!frame.contentWindow?.__BS__?.harness||typeof frame.contentWindow.startRecording!=='function'){if(Date.now()>deadline)throw Error('Guest startup timeout');await sleep(250);}
 start=performance.now();active=true;frame.contentWindow.startRecording();
 for(const type of ['keydown','keyup','pointerdown','pointerup','wheel'])frame.contentWindow.addEventListener(type,e=>{if(active)persist('input',{type,key:e.key,code:e.code,repeat:e.repeat,button:e.button,x:e.clientX,y:e.clientY,deltaY:e.deltaY});},true);
 frame.contentWindow.addEventListener('blur',()=>{if(active)persist('blur',{});});
 await persist('start',{game:'NFSU',bundle:'G:/WGB/running/nfs-underground.wgb',origin:location.origin,userAgent:navigator.userAgent,note:'Manual navigation; host timestamps and periodic scene observations, not deterministic replay. Screenshots add overhead; do not use for FPS.'});
 if(saveError)throw Error(saveError);
 stop.disabled=false;timer=setInterval(checkpoint,2000);
 await call('openWgb','G:/WGB/running/nfs-underground.wgb',{reload:false});
 await checkpoint();if(saveError)throw Error(saveError);
 status.textContent='● Запись включена. Кликните по игре и проведите её в гонку. Снимки и ввод сохраняются на диск.';
 }catch(e){status.textContent=String(e);}};
stop.onclick=async()=>{stop.disabled=true;clearInterval(timer);try{while(checkpointBusy)await sleep(50);await checkpoint();active=false;const samples=frame.contentWindow.stopRecording();await persist('host-recording',samples);await persist('stop',{samples:samples.length});await queue;if(saveError)throw Error(saveError);status.textContent=`Сохранено: ${samples.length} событий ввода. ${config.directory}`;}catch(e){status.textContent='Ошибка: '+e;}};
window.addEventListener('beforeunload',e=>{if(active){e.preventDefault();e.returnValue='';}});
