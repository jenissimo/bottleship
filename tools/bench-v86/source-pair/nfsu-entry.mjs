const button=document.querySelector('#start'),status=document.querySelector('#status'),log=document.querySelector('#log');
const useMenu=new URLSearchParams(location.search).get('menu')==='1';
const target=useMenu?'Golf GTI':'Skyline';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let frame,seq,config,templates;
const note=s=>{status.textContent=s;log.textContent+=s+'\n';};
async function call(cmd,...args){const r=await frame.contentWindow.__BS__.harness.__runSteps([{cmd,args}]);if(!r.ok)throw Error(cmd+': '+JSON.stringify(r.error));return r.steps.at(-1).result;}
async function save(kind,data){if(kind==='checkpoint'&&frame?.contentWindow?.__BS__?.harness)data.memory=await call('evalWorker',`const m=System.getInstance().process.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength);return {mode:v.getUint32(0x777cc8,true),frontEnd:v.getUint32(0x777b4c,true),carChoice:Array.from(m.slice(0x758c28,0x758c38)),transmission:v.getUint32(0x758974,true),selection:Array.from(m.slice(0x748f70,0x748f90)),freeRunOptions:Array.from(m.slice(0x7589e0,0x758a04)),raceParameters:Array.from(m.slice(0x78a2f0,0x78a428))};`);const r=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seq:seq++,kind,t:performance.now(),data})});if(!r.ok)throw Error('Collector HTTP '+r.status);}
async function seedSettings(){const fixture=await(await fetch('./nfsu-entry-settings.json')).json();const backups=[];for(const f of fixture.files){let before;try{before=await call('containerRead',fixture.container,f.path);}catch(e){if(!String(e).includes('NOT_FOUND'))throw e;before={missing:true};}backups.push({path:f.path,before});}await save('settings-backup',{container:fixture.container,files:backups});
 for(const f of fixture.files){await call('containerWrite',fixture.container,f.path,f.base64);const read=await call('containerRead',fixture.container,f.path);if(read.content!==f.base64)throw Error('Settings readback mismatch '+f.path);}await save('settings-seeded',{source:fixture.source,files:fixture.files.map(({path,sha256})=>({path,sha256}))});}
async function directRace(){note('Задаю параметры Free Run и ставлю штатный запуск в очередь игры');const guard=await(await fetch('./nfsu-entry-guards.json')).json();await call('pause');const result=await call('evalWorker',`const s=System.getInstance(),m=s.process.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength);const guards=${JSON.stringify(guard.guards)};for(const g of guards)for(let i=0;i<g.bytes.length;i++)if(m[g.va+i]!==g.bytes[i])throw Error('Executable guard mismatch at '+(g.va+i).toString(16));if(!s.isPaused||v.getUint32(0x73619c,true)!==0||v.getUint32(0x777b4c,true)!==2||v.getUint32(0x77a904,true)!==0)throw Error('Not an idle main menu');const before={mode:v.getUint32(0x777cc8,true),track:v.getUint32(0x7589e8,true),traffic:v.getUint32(0x7589f8,true),queue:v.getUint32(0x77a904,true)};state.entrySeedBackup=before;v.setUint32(0x777cc8,3,true);v.setUint32(0x7589e8,1003,true);v.setUint32(0x7589f8,0,true);v.setUint32(0x77a908,0,true);v.setUint32(0x77a90c,0,true);v.setUint32(0x77a904,0x4b5c00,true);return {before,queued:0x4b5c00,mode:3,track:1003,traffic:0,guards:guards.length};`);await save('direct-seed',result);await call('resume');}
async function bootProfileShortcut(restore=false){await call('pause');const result=await call('evalWorker',`return import('/src/worker/core/memory/guest-code.ts').then(gc=>{const s=System.getInstance(),m=s.process.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength);if(!s.isPaused||!gc.guestCodeInvalidationStats().wired)throw Error('Paused guest with code invalidation required');const patches=[{va:0x4de225,old:[191,188,161,111,0],next:[191,212,161,111,0]},{va:0x4de273,old:[191,164,161,111,0],next:[191,184,161,111,0]}];const restore=${restore};if(restore&&!state.bootProfilePatched)return {restored:false};for(const p of patches){const expected=restore?p.next:p.old;for(let i=0;i<expected.length;i++)if(m[p.va+i]!==expected[i])throw Error('BootFlow signature mismatch');}const currentScreen=v.getUint32(0x735790,true);if(!restore&&currentScreen!==0)return {applied:false,reason:'BootFlow already constructed',currentScreen};for(const p of patches)if(!gc.writeGuestCode(m,new Uint8Array(restore?p.old:p.next),p.va))throw Error('BootFlow write refused');state.bootProfilePatched=!restore;return {applied:!restore,restored:restore,currentScreen,patches:patches.map(p=>p.va),invalidations:gc.guestCodeInvalidationStats()};});`);await save(restore?'boot-shortcut-restored':'boot-shortcut',result);await call('resume');return result;}
async function key(vk){await save('key',{vk});await call('key',vk,{down:true});try{await sleep(vk>=37&&vk<=40?130:350);}finally{await call('key',vk,{up:true});}await sleep(500);}
async function selectFreeRun(){note('Выбираю Free Run по подсветке пункта');let stable=0;for(let attempt=0;attempt<16;attempt++){
 const shot=await call('shot'),image=await createImageBitmap(new Blob([Uint8Array.from(atob(shot.base64),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();const counts=[];
 for(let i=0;i<6;i++){const d=ctx.getImageData(Math.floor(.60*canvas.width),Math.floor((.213+i*.075)*canvas.height),Math.floor(.28*canvas.width),Math.floor(.042*canvas.height)).data;let n=0;for(let p=0;p<d.length;p+=4)if(d[p]>150&&d[p+1]>170&&d[p+2]>170)n++;counts.push(n);}
 const max=Math.max(...counts),selected=counts.indexOf(max),ordered=[...counts].sort((a,b)=>b-a);await save('menu-selection',{menu:'quick-race-mode',counts,selected});
 if(max>80&&max>ordered[1]*3){if(selected===5){if(++stable>=2){await save('checkpoint',{label:'confirmed-free-run',counts,shot});return;}}else{stable=0;await key(40);}}else stable=0;await sleep(650);
 }throw Error('Не удалось подтвердить выбранный Free Run');}
async function intro(){note('Ожидаю титульный экран; пропускаю только распознанное видео');const deadline=Date.now()+120000;let skips=0,previous=null;while(Date.now()<deadline){try{const shot=await call('shot'),score=await distances(shot,['title']);if(score.title<17){await waitScreen('title',10000);return;}
 const image=await createImageBitmap(new Blob([Uint8Array.from(atob(shot.base64),c=>c.charCodeAt(0))],{type:'image/png'}));const c=new OffscreenCanvas(32,24),ctx=c.getContext('2d');ctx.drawImage(image,0,0,32,24);image.close();const d=ctx.getImageData(0,0,32,24).data;let black=0,count=0,mid=0,motion=0;for(let y=0;y<24;y++)for(let x=0;x<32;x++){const i=(y*32+x)*4,l=(d[i]+d[i+1]+d[i+2])/3;if(y<2||y>=22){count++;if(l<18)black++;}else{mid+=l;if(previous)motion+=Math.abs(l-previous[y*32+x]);}}const current=Array.from({length:768},(_,i)=>(d[i*4]+d[i*4+1]+d[i*4+2])/3);
 if(previous&&black/count>.97&&mid/640>25&&motion/640>4&&skips<8){await save('intro-skip',{skips:++skips,black:black/count,motion:motion/640});await key(13);await sleep(1500);previous=null;}else previous=current;
 }catch(e){if(!String(e).includes('UNSUPPORTED'))throw e;}await sleep(500);}throw Error('Титульный экран не появился');}
async function distances(shot,names){const bytes=Uint8Array.from(atob(shot.base64),c=>c.charCodeAt(0));const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=new OffscreenCanvas(48,24),ctx=canvas.getContext('2d');const out={};try{for(const name of names){const t=templates[name],c=t.crop;ctx.drawImage(image,Math.floor(c[0]*image.width),Math.floor(c[1]*image.height),Math.floor((c[0]+c[2])*image.width)-Math.floor(c[0]*image.width),Math.floor((c[1]+c[3])*image.height)-Math.floor(c[1]*image.height),0,0,48,24);const pixels=ctx.getImageData(0,0,48,24).data;let sum=0;for(let i=0;i<t.rgb.length;i++)sum+=Math.abs(t.rgb[i]-pixels[Math.floor(i/3)*4+i%3]);out[name]=sum/t.rgb.length;}return out;}finally{image.close();}}
async function waitScreen(names,timeout=45000,threshold=17){if(typeof names==='string')names=[names];note('Ожидаю: '+names.join(' / '));const end=Date.now()+timeout;let best=null,lastShot,lastScores,streak=0,previous;
 while(Date.now()<end){try{lastShot=await call('shot');lastScores=await distances(lastShot,names);const winner=names.reduce((a,b)=>lastScores[a]<lastScores[b]?a:b);best={name:winner,distance:lastScores[winner]};if(best.distance<threshold){streak=previous===winner?streak+1:1;previous=winner;if(streak>=2){await save('checkpoint',{label:'screen:'+winner,scores:lastScores,shot:lastShot});return winner;}}else{streak=0;previous=null;}}catch(e){if(!String(e).includes('UNSUPPORTED'))throw e;}await sleep(500);}
 await save('checkpoint',{label:'timeout:'+names.join('/'),scores:lastScores,shot:lastShot});throw Error('Экран не подтверждён: '+JSON.stringify(best));}
async function engineIdentity(){const deadline=Date.now()+30000;let last=null;while(Date.now()<deadline){last=await call('evalWorker',`const e=globalThis.__v86EngineLoad;return e?{...e}:null;`);if(last&&(last.sha256||last.error))return last;await sleep(200);}throw Error('Engine identity unresolved: '+JSON.stringify(last));}
const sceneCode=`const s=System.getInstance(),m=s.process.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength),ptr=v.getUint32(0x73619c,true);return {racePointer:ptr,raceState:ptr&&ptr+4<=m.length?v.getUint32(ptr,true):null,moverCounter:v.getUint32(0x78eb4c,true),serial:s.services.render.getPresentSerial(),paused:s.isPaused,mode:v.getUint32(0x777cc8,true),track:v.getUint32(0x78a2f0,true),traffic:v.getUint32(0x78a300,true),players:v.getUint32(0x78a320,true)};`;
// Exposed so a series runner can drive repeated entries with different engines in ONE page:
// the engine is bound when the iframe's worker boots, and this creates a fresh iframe per call,
// so alternating arms needs no parent navigation.
async function enter(engineHash){seq=Date.now();log.textContent='';try{
 if(location.origin!=='http://127.0.0.1:5174')throw Error('Use isolated lab origin 127.0.0.1:5174');
 config=await(await fetch('./navigation-record-config.json',{cache:'no-store'})).json();templates=await(await fetch('./nfsu-entry-templates.json')).json();
 await save('entry-start',{target:'NFSU Free Run / '+target+' / Olympic Square / Traffic None',reference:'nfsu-navigation-RibI1M',independentReplayVerified:false});
 // The engine binary is chosen when the worker boots (initV86 runs on the iframe's `init`
 // message), so the flags must already be in localStorage BEFORE the iframe exists. Setting
 // them through the harness afterwards persists them for a reload that openWgb({reload:false})
 // never performs: both arms would silently instantiate the shipping /v86.wasm.
 let enginePath=null;
 const globalFlags=JSON.parse(localStorage.getItem('bs_debug_flags')||'{}');
 if(Object.keys(globalFlags).length)throw Error('Origin-wide bs_debug_flags is not empty: '+JSON.stringify(globalFlags));
 localStorage.removeItem('bs_debug_flags:nfsu-entry');
 // ?flags={"__d3d9PtrShadow":true} — extra worker flags seeded BEFORE the iframe, for a
 // registration-time switch that a post-load setWorkerFlag could never reach.
 const extraFlags=new URLSearchParams(location.search).get('flags');
 const extra=extraFlags?JSON.parse(extraFlags):null;
 if(extra&&!engineHash){
  localStorage.setItem('bs_debug_flags:nfsu-entry',JSON.stringify(extra));
  await save('extra-flags',extra);
 }
 if(engineHash){
  if(!/^[a-f0-9]{64}$/.test(engineHash))throw Error('Invalid engine hash');
  enginePath='/apps/source-pair-lab/engines/'+engineHash+'.wasm';
  const response=await fetch(enginePath);if(!response.ok)throw Error('Engine HTTP '+response.status);
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  if(actual!==engineHash)throw Error('Engine hash mismatch');
  localStorage.setItem('bs_debug_flags:nfsu-entry',JSON.stringify({...(extra||{}),__v86LabWasmPath:enginePath,__aotNoAutoLoad:true}));
 }
 frame?.remove();frame=document.createElement('iframe');frame.src='/?game=dev&bs=nfsu-entry';document.querySelector('#guest').append(frame);
 const deadline=Date.now()+90000;while(!frame.contentWindow?.__BS__?.harness){if(Date.now()>deadline)throw Error('Harness timeout');await sleep(250);}
 const engineLoad=await engineIdentity();
 if(engineHash){
  if(engineLoad.path!==enginePath||engineLoad.sha256!==engineHash)throw Error('Engine not instantiated as requested: '+JSON.stringify(engineLoad));
  await save('engine-selection',{engineHash,enginePath,engineLoad,aot:'disabled; fresh JIT'});
 }else{
  await save('engine-selection',{engineHash:null,engineLoad,aot:'default'});
 }
 note('Восстанавливаю максимальные настройки и профиль');await seedSettings();
 const route=await diskBundleUrl('G:/WGB/running/nfs-underground.wgb'),cacheKey=WgbCache.keyForUrl(route.url),old=(await loadOverrides())[cacheKey]??null;
 await save('manifest-backup',{cacheKey,old});await saveOverride(cacheKey,{...old,emulator:{...old?.emulator,skipVideo:true}});
 note('Загружаю NFSU без intro');await call('openWgb',route.url,{reload:false});await save('video-config',await call('evalWorker',`return import('/src/worker/core/emulator-config-manager.ts').then(m=>({skipVideo:m.EmulatorConfig.getInstance().skipVideo,force:globalThis.__forceVideoPlayback}));`));
 const shortcut=await bootProfileShortcut();if(!shortcut.applied){await intro();await sleep(2500);await key(13);}
 await waitScreen('profile');await bootProfileShortcut(true);await sleep(1200);await key(13);await waitScreen('main');
 if(!useMenu){await sleep(1500);await directRace();}else{await key(13);
 await waitScreen('mode');await selectFreeRun();await key(13);
 await waitScreen('car');await key(13);await waitScreen('transmission');await key(13);
 await waitScreen('track',45000,10);await key(13);
 const traffic=await waitScreen(['minimum','none'],45000,12);if(traffic==='minimum'){await key(38);await key(37);await key(40);}if(await waitScreen(['minimum','none'],10000,12)!=='none')throw Error('Traffic None не подтверждён');await key(13);}
 note('Ожидаю отсчёт и начало гонки');let countdown=false,active=null;const raceDeadline=Date.now()+90000;let last;
 while(Date.now()<raceDeadline){const s=await call('evalWorker',sceneCode);if(s.raceState!==last){await save('race-transition',s);last=s.raceState;}if(s.raceState===3)countdown=true;if(countdown&&s.raceState===4){active=s;break;}await sleep(100);}
 if(!active)throw Error('Не подтверждён переход отсчёт → гонка');
 await waitScreen(useMenu?'race':'raceSkyline',15000,24);if(!useMenu)await waitScreen('skylineCar',10000,20);const final=await call('evalWorker',sceneCode);if(final.raceState!==4||final.moverCounter<=active.moverCounter||final.serial<=active.serial||final.mode!==3||final.track!==1003||final.traffic!==0||final.players!==1)throw Error('Не совпали параметры гонки или физика не продвигается');
 await call('pause');await save('entry-complete',{active,final,paused:await call('evalWorker',sceneCode),target:'Free Run / Traffic None / '+target,note:'Visual/state-validated entry, not deterministic simulation snapshot or performance sample'});
 note('Готово: Free Run без трафика. Сцена проверена и оставлена на паузе.');
 }catch(e){let cleanupError=null;try{if(frame?.contentWindow?.__BS__?.harness){await bootProfileShortcut(true);await call('pause');}}catch(cleanup){cleanupError=String(cleanup);try{await call('pause');}catch{}}try{await save('entry-failed',{error:String(e),cleanupError});}catch{}note('Остановлено: '+e+(cleanupError?' · cleanup: '+cleanupError:''));}finally{}}
button.onclick=async()=>{button.disabled=true;try{await enter(new URLSearchParams(location.search).get('engine'));}finally{button.disabled=false;}};
window.__nfsuEnter=enter;
window.__nfsuEntered=()=>status.textContent.startsWith('Готово');
import {diskBundleUrl} from '/src/utils/bundle-url.ts';
import {loadOverrides,saveOverride} from '/src/wgb-library.ts';
import {WgbCache} from '/src/worker/runtime/filesystem/wgb-cache.ts';
