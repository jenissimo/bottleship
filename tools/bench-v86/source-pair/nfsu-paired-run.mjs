// Same-session A/C diagnostic. Full semantic validation is a separate acceptance gate.
export async function paired({call,save,note,sleep},payload,{identity=false,seconds=10}={}){
 const patch=await(await fetch(payload)).json();let replaced=false;
 const cpu=`const s=System.getInstance(),p=s.process,c=p.v86?.cpu??p.v86?.v86?.cpu,w=c.wm.exports,t=c.wm.wasm_table,r=s.services.render;`;
 const inspect=reset=>call('evalWorker',cpu+`${reset?'r.resetFlipCadence();':''}const m=p.getCurrentMemory(),v=new DataView(m.buffer,m.byteOffset,m.byteLength),ptr=v.getUint32(0x73619c,true);return {raceState:ptr?v.getUint32(ptr,true):null,mode:v.getUint32(0x777cc8,true),track:v.getUint32(0x78a2f0,true),traffic:v.getUint32(0x78a300,true),players:v.getUint32(0x78a320,true),mover:v.getUint32(0x78eb4c,true),serial:r.getPresentSerial(),guestSerial:r.getGuestPresentSerial(),source:r.getLastPresenterKind(),raw:Array.from(r.flipIntervals),config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),compile:globalThis.__jitCompileStats?.count??0,variants:state.hotVariants.map(v=>({idx:v.idx,sameFn:t.get(v.slot)===v.current,ownsPages:v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx),entries:w.jit_get_module_entry_total(v.idx)>>>0}))};`);
 const select=arm=>call('evalWorker',cpu+`for(const v of state.hotVariants){if(t.get(v.slot)!==v.current||!v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx))throw Error('Variant ownership lost');v.current=v.${arm==='A'?'original':'candidate'};t.set(v.slot,v.current);}return true;`);
 const validScene=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const rows=[];
 try{
  await call('pause');const version=await call('dbgCall','aot','version');if(JSON.stringify(version)!==JSON.stringify(patch.version))throw Error('AOT version mismatch');
  await call('perfProfile',{enable:false});await call('dbgCall','aot','disarm');await call('jitPublications','clear');
  await save('paired-start',{payload,identity,version,units:patch.units.map(({tableIndex,inputSha256,outputSha256})=>({tableIndex,inputSha256,outputSha256})),note:'Exploratory scene/ownership checks, not full architectural equivalence'});
  await call('evalWorker',cpu+`state.hotVariants=[];for(const u of ${JSON.stringify(patch.units.map(u=>({tableIndex:u.tableIndex,pages:u.pages,original:u.original,inputSha256:u.inputSha256})))}){const b=Uint8Array.from(atob(u.original),c=>c.charCodeAt(0));const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');if(h!==u.inputSha256)throw Error('Original hash mismatch');const original=new WebAssembly.Instance(new WebAssembly.Module(b),{e:c.jit_imports}).exports.f;state.hotVariants.push({idx:u.tableIndex,slot:u.tableIndex+1024,pages:u.pages,original,current:null,candidate:null});}return true;`);
  await call('aotArtifacts','replace',{engine:patch.version.engine,units:patch.units.map(u=>({tableIndex:u.tableIndex,inputSha256:u.inputSha256,base64:identity?u.original:u.candidate}))});replaced=true;
  await call('dbgCall','aot','drop');await save('paired-replay',await call('dbgCall','aot','replay'));
  await call('evalWorker',cpu+`for(const v of state.hotVariants){if(!v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx))throw Error('Replay refused target');v.candidate=t.get(v.slot);v.current=v.candidate;}return true;`);
  for(const arm of ['A','C']){await select(arm);await call('resume');note('Прогрев '+arm+': 10 секунд');await sleep(10000);await call('pause');await save('paired-warmup',{arm,state:await inspect(false),invalidations:await call('codeInvalidations')});}
  for(const arm of ['A','C','C','A','C','A','A','C']){
   await select(arm);await call('resume');const before=await inspect(true);note('Парное окно '+arm+' · '+(rows.length+1)+'/8');await sleep(seconds*1000);const after=await inspect(false);await call('pause');
   const raw=after.raw,delta=after.serial-before.serial,entries=after.variants.map((v,i)=>(v.entries-before.variants[i].entries)>>>0);
   const valid=validScene(before)&&validScene(after)&&after.mover>before.mover&&before.source===after.source&&before.config[21]===0&&JSON.stringify(before.config)===JSON.stringify(after.config)&&before.compile===after.compile&&raw.length===delta-1&&raw.length>100&&after.guestSerial-before.guestSerial===delta&&[before,after].every(s=>s.variants.every(v=>v.sameFn&&v.ownsPages))&&entries.every(x=>x>0);
   const sorted=[...raw].sort((a,b)=>a-b),row={arm,valid,before,after,entries,fps:raw.length*1000/raw.reduce((a,b)=>a+b,0),p95:sorted[Math.ceil(raw.length*.95)-1]};rows.push(row);await save('paired-window',row);if(!valid)throw Error('Paired window integrity failed');
  }
  const median=a=>{a.sort((x,y)=>x-y);return(a[1]+a[2])/2;},A=median(rows.filter(r=>r.arm==='A').map(r=>r.fps)),C=median(rows.filter(r=>r.arm==='C').map(r=>r.fps));
  await save('paired-complete',{identity,A,C,ratio:C/A,fps:rows.map(r=>({arm:r.arm,fps:r.fps})),performanceAccepted:false});note('Парный прогон завершён; возвращаю исходный AOT.');
 }finally{
  await call('pause');if(replaced){await call('aotArtifacts','replace',{engine:patch.version.engine,units:patch.units.map(u=>({tableIndex:u.tableIndex,inputSha256:identity?u.inputSha256:u.outputSha256,base64:u.original}))});await call('dbgCall','aot','drop');await save('paired-restored',await call('dbgCall','aot','replay'));}
 }
}
