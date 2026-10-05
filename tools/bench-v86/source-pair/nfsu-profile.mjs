const button=document.createElement('button');
button.textContent='Снять профиль готовой сцены';
document.querySelector('#start').after(button);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const scene=`const s=System.getInstance(),p=s.process,r=s.services.render,c=p.v86?.cpu??p.v86?.v86?.cpu,w=c.wm.exports,m=p.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength),ptr=v.getUint32(0x73619c,true);return {paused:s.isPaused,raceState:ptr?v.getUint32(ptr,true):null,mode:v.getUint32(0x777cc8,true),track:v.getUint32(0x78a2f0,true),traffic:v.getUint32(0x78a300,true),players:v.getUint32(0x78a320,true),mover:v.getUint32(0x78eb4c,true),serial:r.getPresentSerial(),guestSerial:r.getGuestPresentSerial(),source:r.getLastPresenterKind(),raw:Array.from(r.flipIntervals),config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),compile:globalThis.__jitCompileStats?.count??0,time:performance.now()};`;
window.__nfsuScene=scene;
button.onclick=async()=>{
 if(document.querySelector('#start').disabled)return;
 const start=document.querySelector('#start'),status=document.querySelector('#status'),log=document.querySelector('#log');
 const note=s=>{status.textContent=s;log.textContent+=s+'\n';};
 const frame=document.querySelector('#guest iframe');
 const call=async(cmd,...args)=>{const r=await frame.contentWindow.__BS__.harness.__runSteps([{cmd,args}]);if(!r.ok)throw Error(cmd+': '+JSON.stringify(r.error));return r.steps.at(-1).result;};
 let seq=Date.now(),profile=false;
 const config=await(await fetch('./navigation-record-config.json')).json();
 const save=async(kind,data)=>{const r=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seq:seq++,kind,t:performance.now(),data})});if(!r.ok)throw Error('Collector '+r.status);};
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 button.disabled=start.disabled=true;
 try{
  const initial=await call('evalWorker',scene);if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
  await save('profile-start',{initial,note:'Clean cadence then instrumented attribution; same-boot descriptive diagnostics'});
  await call('perfProfile',{enable:false});await call('resume');note('Прогрев сцены: 15 секунд');await sleep(15000);
  await call('evalWorker','System.getInstance().services.render.resetFlipCadence();return true;');
  const before=await call('evalWorker',scene);note('Чистое окно кадров: 20 секунд');await sleep(20000);
  const after=await call('evalWorker',scene);await call('pause');
  const raw=after.raw,frames=after.serial-before.serial,ordered=[...raw].sort((a,b)=>a-b);
  const integrity=valid(before)&&valid(after)&&after.mover>before.mover&&raw.length===frames-1&&frames>100&&after.guestSerial-before.guestSerial===frames&&before.source===after.source&&JSON.stringify(before.config)===JSON.stringify(after.config)&&after.compile===before.compile;
  await save('profile-clean',{valid:integrity,before,after,fps:raw.length*1000/raw.reduce((a,b)=>a+b,0),p50:ordered[Math.ceil(raw.length*.5)-1],p95:ordered[Math.ceil(raw.length*.95)-1],p99:ordered[Math.ceil(raw.length*.99)-1]});
  if(!integrity)throw Error('Clean window integrity failed');
  await call('perfProfile',{enable:true,reset:true});profile=true;await call('frameReport',{reset:true,budgetMs:33.34});
  await call('resume');note('Профиль затрат кадра: 15 секунд');await sleep(15000);await call('pause');
  for(const cmd of ['perfStats','frameReport','perfThunks','profilerStats'])await save('profile-'+cmd,await call(cmd,cmd==='profilerStats'?{top:40,sort:'total'}:{top:40}));
  await call('perfProfile',{enable:false});profile=false;
  await call('resume');note('Отдельный профиль гостевых блоков: 8 секунд');
  await save('profile-guestBlocks',await call('guestBlocks',{ms:8000,intervalMs:5,top:50,maxPages:256}));
  await call('pause');await save('profile-complete',{scene:await call('evalWorker',scene)});
  note('Профиль сохранён. Сцена на паузе.');
 }catch(e){await save('profile-failed',{error:String(e)}).catch(()=>{});note('Профиль остановлен: '+e);}
 finally{if(profile)await call('perfProfile',{enable:false}).catch(()=>{});if(frame)await call('pause').catch(()=>{});button.disabled=start.disabled=false;}
};
const experiment=document.createElement('button');experiment.textContent='Запустить текущий эксперимент';button.after(experiment);
experiment.onclick=async()=>{
 const start=document.querySelector('#start');if(start.disabled||button.disabled)return;
 const frame=document.querySelector('#guest iframe');if(!frame)return;
 const call=async(cmd,...args)=>{const r=await frame.contentWindow.__BS__.harness.__runSteps([{cmd,args}]);if(!r.ok)throw Error(cmd+': '+JSON.stringify(r.error));return r.steps.at(-1).result;};
 const cfg=await(await fetch('./navigation-record-config.json')).json();let seq=Date.now();
 const save=async(kind,data)=>{const r=await fetch(cfg.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seq:seq++,kind,t:performance.now(),data})});if(!r.ok)throw Error('Collector '+r.status);};
 const note=s=>{document.querySelector('#status').textContent=s;document.querySelector('#log').textContent+=s+'\n';};
 start.disabled=button.disabled=experiment.disabled=true;
 try{const {run}=await import('./nfsu-experiment.mjs?run='+seq);await run({call,save,note,sleep,scene});}
 catch(e){await save('experiment-failed',{error:String(e)}).catch(()=>{});note('Эксперимент остановлен: '+e);}
 finally{await call('pause').catch(()=>{});start.disabled=button.disabled=experiment.disabled=false;}
};
