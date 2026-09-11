// Import-call frequency only. Wrappers perturb execution; never use this window for timings.
export async function census({call,save,note,sleep,scene}){
 const payload=await(await fetch('/apps/source-pair-lab/nfsu-binaryen-stable.json')).json();
 const cpu=`const s=System.getInstance(),c=s.process.v86?.cpu??s.process.v86?.v86?.cpu,w=c.wm.exports,t=c.wm.wasm_table;`;
 const inspect=()=>call('evalWorker',cpu+`return state.helperCensus.map(v=>({idx:v.idx,sameFn:t.get(v.slot)===v.instrumented,ownsPages:v.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===v.idx),entries:w.jit_get_module_entry_total(v.idx)>>>0,calls:{...v.calls}}));`);
 let installed=false;
 try{
  await call('pause');const initial=await call('evalWorker',scene);if(initial.raceState!==4||initial.traffic!==0)throw Error('Race scene required');
  const version=await call('dbgCall','aot','version');if(JSON.stringify(version)!==JSON.stringify(payload.version))throw Error('Version mismatch');
  await call('perfProfile',{enable:false});await call('dbgCall','aot','disarm');await call('dbgCall','aot','drop');await save('helper-replay',await call('dbgCall','aot','replay'));
  await call('resume');note('Прогрев исходных модулей перед census: 10 секунд');await sleep(10000);await call('pause');
  await save('helper-install',await call('evalWorker',cpu+`state.helperCensus=[];for(const u of ${JSON.stringify(payload.units.map(({tableIndex,pages,original,inputSha256})=>({tableIndex,pages,original,inputSha256})))}){
   if(!u.pages.every(p=>(w.jit_aot_page_table_index(p*4096)>>>0)===u.tableIndex))throw Error('Unstable target '+u.tableIndex);
   const bytes=Uint8Array.from(atob(u.original),c=>c.charCodeAt(0));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==u.inputSha256)throw Error('Hash mismatch');
   const module=new WebAssembly.Module(bytes),calls={},imports={...c.jit_imports},detail={dynamic:{targets:{},unique:0,overflow:0,success:0,fallback:0,retiredSum:0,retiredHistogram:{}},wbuf:{targets:{},unique:0,overflow:0,success:0,fallback:0}};
   const target=(d,key)=>{if(d.targets[key]!==undefined)d.targets[key]++;else if(d.unique<256){d.targets[key]=1;d.unique++;}else d.overflow++;};
   for(const im of WebAssembly.Module.imports(module))if(im.kind==='function'){if(im.module!=='e')throw Error('Unexpected import namespace');const fn=c.jit_imports[im.name];if(typeof fn!=='function')throw Error('Missing import '+im.name);calls[im.name]=0;
    if(im.name==='jit_find_cache_entry_for_dynamic_chaining')imports[im.name]=(flags,idx,retired)=>{calls[im.name]++;const d=detail.dynamic;target(d,c.instruction_pointer[0]>>>0);d.retiredSum+=retired>>>0;const bucket=retired===0?0:2**Math.floor(Math.log2(retired>>>0));d.retiredHistogram[bucket]=(d.retiredHistogram[bucket]??0)+1;const result=fn(flags,idx,retired);if(result<0)d.fallback++;else d.success++;return result;};
    else if(im.name==='jit_wbuf_intrinsic_execute')imports[im.name]=(addr,esp)=>{calls[im.name]++;const d=detail.wbuf;target(d,addr>>>0);const result=fn(addr,esp);if(result<0)d.fallback++;else d.success++;return result;};
    else imports[im.name]=(...args)=>{calls[im.name]++;return fn(...args);};}
   const instrumented=new WebAssembly.Instance(module,{e:imports}).exports.f;state.helperCensus.push({idx:u.tableIndex,slot:u.tableIndex+1024,pages:u.pages,calls,detail,instrumented});
  }for(const v of state.helperCensus)t.set(v.slot,v.instrumented);return state.helperCensus.map(v=>({idx:v.idx,pages:v.pages,imports:Object.keys(v.calls)}));`));installed=true;
  const before=await call('evalWorker',scene),unitsBefore=await inspect();await call('resume');note('Считаю вызовы helpers: 5 секунд; это не замер скорости');await sleep(5000);await call('pause');
  const after=await call('evalWorker',scene),units=await inspect(),frames=after.serial-before.serial;
  const valid=frames>0&&after.raceState===4&&after.mode===before.mode&&after.track===before.track&&after.traffic===0&&after.mover>before.mover&&units.every(v=>v.sameFn&&v.ownsPages)&&after.compile===before.compile;
  const totals={};for(const u of units)for(const [name,n] of Object.entries(u.calls))totals[name]=(totals[name]??0)+n;
  await save('helper-census',{valid,before,after,frames,unitsBefore,units,detail:await call('evalWorker','return state.helperCensus.map(v=>({idx:v.idx,...v.detail}));'),totals:Object.entries(totals).map(([name,calls])=>({name,calls,perFrame:calls/frames})).sort((a,b)=>b.calls-a.calls),note:'Direct imported-helper call counts in three selected modules only; JS-wrapper overhead invalidates timings and may change scheduling.'});
  if(!valid)throw Error('Census integrity failed');note('Частоты helpers сохранены; восстанавливаю исходный AOT.');
 }finally{
  await call('pause');if(installed){await call('dbgCall','aot','drop');await save('helper-restored',await call('dbgCall','aot','replay'));await call('evalWorker','delete state.helperCensus;return true;');}
 }
}
