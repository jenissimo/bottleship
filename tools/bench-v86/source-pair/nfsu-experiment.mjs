export async function hotspots({call,save,note,sleep,scene}){
 await call('pause');await save('hotspot-start',await call('evalWorker',scene));
 await call('resume');note('Прогрев перед точным профилем EIP');await sleep(12000);
 note('Выборка адресов инструкций: 10 секунд');
 await save('hotspot-eip',await call('eipProfile',{ms:10000,intervalMs:2,top:60}));
 note('Считаю исполнения на выбранных горячих страницах: 8 секунд');
 await save('hotspot-blocks',await call('guestBlocks',{ms:8000,intervalMs:5,top:80,pages:[0x5d0000,0x63e000,0x40a000,0x40e000,0x5cd000,0x40f000,0x5c9000,0x5ca000,0x5d3000,0x5cf000]}));
 await call('pause');await save('hotspot-complete',await call('evalWorker',scene));note('Точный профиль сохранён; игра на паузе.');
}
export async function memoProbe({call,save,note,sleep}){
 const cpu=`const s=System.getInstance(),p=s.process,c=p.v86?.cpu??p.v86?.v86?.cpu,w=c.wm.exports;`;
 try{await call('pause');await save('memo-probe-start',await call('evalWorker',cpu+`state.memoProbePrev=w.get_dispatch_stats();w.set_dispatch_stats(1);return {previous:state.memoProbePrev,counters:Array.from({length:5},(_,i)=>Number(w.profiler_dispatch_stat_get(18+i))),wbuf:{enabled:w.jit_wbuf_intrinsic_get_enabled(),registered:w.jit_wbuf_intrinsic_get_registered(),min:w.jit_wbuf_intrinsic_get_min_target(),max:w.jit_wbuf_intrinsic_get_max_target()},stubs:[553954608,553954624].map(a=>p.dispatcher.thunkGenerator.getStubByAddress(a)??{address:a,missing:true})};`));
 await call('resume');note('Измеряю причины отказов динамического перехода: 5 секунд');await sleep(5000);await call('pause');await save('memo-probe-end',await call('evalWorker',cpu+`return {counters:Array.from({length:5},(_,i)=>Number(w.profiler_dispatch_stat_get(18+i))),wbufHits:w.jit_wbuf_intrinsic_get_hits(),wbufFallbacks:w.jit_wbuf_intrinsic_get_fallbacks()};`));}
 finally{await call('pause');await call('evalWorker',cpu+`if(state.memoProbePrev!==undefined){w.set_dispatch_stats(state.memoProbePrev);delete state.memoProbePrev;}return true;`);note('Причины переходов сохранены; игра на паузе.');}
}
export async function wbufGlobal({call,save,note,sleep,scene}){
 const stats=()=>call('evalWorker',`const s=System.getInstance(),p=s.process,c=p.v86?.cpu??p.v86?.v86?.cpu,w=c.wm.exports;return {hits:w.jit_wbuf_intrinsic_get_hits()>>>0,fallbacks:w.jit_wbuf_intrinsic_get_fallbacks()>>>0,serial:s.services.render.getPresentSerial()};`);
 await call('pause');await save('wbuf-global-start',{scene:await call('evalWorker',scene),stats:await stats()});
 try{await call('resume');note('Измеряю WBUF по всему кадру: 5 секунд');await sleep(5000);await call('pause');await save('wbuf-global-end',{scene:await call('evalWorker',scene),stats:await stats()});}
 finally{await call('pause');note('Глобальные счётчики WBUF сохранены; игра на паузе.');}
}

/** One engine arm: a warmed, integrity-checked steady-state window on the engine THIS boot
 *  actually instantiated. The engine is chosen at worker init, so arms cannot be interleaved
 *  inside one guest — a quartet is four entries, and the identity below is what makes an arm
 *  attributable to a binary rather than to the hash someone asked for. */
export async function run({call,save,note,sleep,scene}){
 const engine=await call('evalWorker',`const e=globalThis.__v86EngineLoad;return e?{...e}:null;`);
 if(!engine||!engine.sha256)throw Error('Engine identity unavailable: '+JSON.stringify(engine));
 const wbuf=()=>call('evalWorker',`const s=System.getInstance(),p=s.process,c=p.v86?.cpu??p.v86?.v86?.cpu,w=c.wm.exports;return {hits:w.jit_wbuf_intrinsic_get_hits()>>>0,fallbacks:w.jit_wbuf_intrinsic_get_fallbacks()>>>0};`);
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 await call('perfProfile',{enable:false});
 await call('resume');note('Прогрев ('+engine.sha256.slice(0,8)+'): 15 секунд');await sleep(15000);
 await call('evalWorker','System.getInstance().services.render.resetFlipCadence();return true;');
 const before=await call('evalWorker',scene),wbufBefore=await wbuf();
 note('Окно кадров: 20 секунд');await sleep(20000);
 const after=await call('evalWorker',scene),wbufAfter=await wbuf();
 await call('pause');
 const raw=after.raw,frames=after.serial-before.serial,ordered=[...raw].sort((a,b)=>a-b);
 // The cadence reset happens with the guest RUNNING, so a flip can land between it and the
 // serial read: one interval more or less than the present delta is that race, not a lost
 // frame. Anything outside +-1 IS loss (a truncated ring, a missed present) and fails.
 const integrity=valid(before)&&valid(after)&&after.mover>before.mover&&(raw.length===frames||raw.length===frames-1)&&frames>100
  &&after.guestSerial-before.guestSerial===frames&&before.source===after.source
  &&JSON.stringify(before.config)===JSON.stringify(after.config)&&after.compile===before.compile;
 const total=raw.reduce((a,b)=>a+b,0);
 await save('engine-window',{engine,valid:integrity,before,after,frames,
  fps:raw.length*1000/total,meanMs:total/raw.length,
  p50:ordered[Math.ceil(raw.length*.5)-1],p95:ordered[Math.ceil(raw.length*.95)-1],p99:ordered[Math.ceil(raw.length*.99)-1],
  moverPerFrame:(after.mover-before.mover)/frames,
  wbuf:{before:wbufBefore,after:wbufAfter,hitsPerFrame:(wbufAfter.hits-wbufBefore.hits)/frames,fallbacksPerFrame:(wbufAfter.fallbacks-wbufBefore.fallbacks)/frames},
  raw});
 if(!integrity)throw Error('Window integrity failed');
 note('Окно записано: '+(raw.length*1000/total).toFixed(2)+' FPS · '+engine.sha256.slice(0,8));
}

/** In-boot paired A/B of a runtime-switchable JIT lever.
 *
 *  The game stand's FPS wanders ~12% between identical arms across boots, so a candidate worth
 *  single digits cannot be resolved by two loads. This alternates the lever INSIDE one guest,
 *  with a JIT cache clear and a fresh warm-up on both sides of every switch, so host drift lands
 *  on both arms. Each window carries the same scene/present/physics/compile checks as
 *  `engine-window`; a window that fails them is not counted.
 */
/** In-boot paired A/B of relaxed FPU: sizes the x87 bucket in FRAME time.
 *
 *  The demo says x87 codegen is 63x native while integer/pointer families sit at ~10x, and the
 *  live census says x87 is 8.82% of retired instructions — but instructions are not time.
 *  Relaxed FPU is worth 3.1x on the x87 kernel and is already shipping ON, so switching it OFF
 *  inside one race measures what that bucket is actually worth per frame. A small delta bounds
 *  the whole x87 direction from above, whatever the 63x says.
 */
export async function relaxedFpuAb(ctx){ return leverAb(ctx,'relaxedfpu'); }
export async function bankHashAb(ctx){ return leverAb(ctx,'bankhash'); }
export async function eaglCursorAb(ctx){ return leverAb(ctx,'eaglcursor'); }
export async function flagLocalsAb(ctx){ return leverAb(ctx,'flaglocals'); }
export async function x87LocalsAb(ctx){ return leverAb(ctx,'x87locals'); }
export async function flagTupleAb(ctx){ return leverAb(ctx,'flagtuple'); }
export async function stackRaw2Ab(ctx){ return leverAb(ctx,'stackraw2'); }
export async function stackRaw3Ab(ctx){ return leverAb(ctx,'stackraw3'); }
export async function comboAb(ctx){ return leverAb(ctx,'combo'); }
export async function capMemoAb(ctx){ return leverAb(ctx,'capmemo'); }
export async function stageWindowAb(ctx){ return leverAb(ctx,'stagewindow'); }
export async function stagePartialAb(ctx){ return leverAb(ctx,'stagepartial'); }

/** Module-boundary traffic: how often the guest leaves a compiled module and has to be
 *  dispatched back in. Every such edge spills eight guest registers, bumps a counter, tries
 *  dynamic chaining and reloads on entry — the cost a region-forming AOT compiler would remove.
 *  Uses the shipping dispatch counters, so it needs no lab engine. */
export async function moduleEdges({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const IDX={blocks:0,reentry:1,exitChainable:2,exitDynamic:3,exitIndirect:4,chainedEdge:5,
   chainBudgetExit:6,chainMiss:7,absEipDispatch:10,retChainHit:11,retChainMiss:12};
 const read=()=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"const I="+JSON.stringify(IDX)+";const o={};"
  +"for(const k in I) o[k]=Number(w.profiler_dispatch_stat_get(I[k]));return o;");
 const prev=await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"const p=w.get_dispatch_stats(); w.set_dispatch_stats(1);"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return p;");
 try{
  await call('resume');note('Прогрев переписи границ модулей: 12 с');await sleep(12000);
  const b=await read(),sb=await call('evalWorker',scene);
  note('Окно переписи: 10 с');await sleep(10000);
  const a=await read(),sa=await call('evalWorker',scene);
  await call('pause');
  const d={};for(const k in b) d[k]=a[k]-b[k];
  const frames=sa.serial-sb.serial;
  const row={windowSeconds:10,frames,perSecond:Object.fromEntries(Object.entries(d).map(([k,v])=>[k,Math.round(v/10)])),
    raw:d,
    reentryPerBlock:d.blocks?d.reentry/d.blocks:null,
    intraModuleEdges:d.blocks-d.reentry,
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover&&frames>50};
  await save('module-edges',row);
  note('блоков '+Math.round(d.blocks/10)+'/с, возвратов в диспетчер '+Math.round(d.reentry/10)
   +'/с ('+(100*(row.reentryPerBlock??0)).toFixed(1)+'% блоков), сцеплённых рёбер '
   +Math.round(d.chainedEdge/10)+'/с, промахов сцепления '+Math.round(d.chainMiss/10)+'/с'
   +(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_dispatch_stats("+ (prev?1:0) +");"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}
export async function targetSizeAb(ctx){ return leverAb(ctx,'targetsize'); }
export async function blockChainAb(ctx){ return leverAb(ctx,'blockchain'); }

/** Where the FRAME goes, as opposed to where the worker's BUSY time goes.
 *  Every ceiling in this campaign was computed against busy time; if a material part of the
 *  frame is spent waiting on the GPU or on present, those ceilings have the wrong denominator
 *  and a whole class of lever was never considered. Uses the shipping frame instruments. */
export async function frameSplit({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 try{
  await call('perfProfile',{enable:true}).catch(()=>null);
  await call('resume');note('Прогрев: 12 с');await sleep(12000);
  const sb=await call('evalWorker',scene);
  note('Окно кадрового разреза: 15 с');await sleep(15000);
  const stats=await call('perfStats').catch(e=>({error:String(e)}));
  const frame=await call('frameReport').catch(e=>({error:String(e)}));
  const gpu=await call('evalWorker',
    "const s=System.getInstance(),r=s.services.render;"
   +"const o={presentSerial:r.getPresentSerial(),kind:r.getLastPresenterKind()};"
   +"try{o.d3d9=Object.fromEntries(Object.entries((globalThis.dbg&&globalThis.dbg.d3d9Perf?globalThis.dbg.d3d9Perf():{}).timings||{}));}catch(e){o.d3d9Error=String(e);}"
   +"return o;").catch(e=>({error:String(e)}));
  const sa=await call('evalWorker',scene);
  await call('pause');
  const row={stats,frame,gpu,valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('frame-split',row);
  note('кадровый разрез снят: '+JSON.stringify(stats).slice(0,300));
 } finally {
  await call('pause').catch(()=>{});
  await call('perfProfile',{enable:false}).catch(()=>null);
 }
}

/** bytesByOpcode with the inline TLB guard chain removed from flat reads, so the per-opcode
 *  drop names how many of each form's bytes ARE the guard and how many are the translation.
 *  Unsound arm (a raw read can no longer fault) — a byte census, never a timing arm. */
export async function bytesByOpcodeNoGuards(ctx){
 await ctx.call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"w.set_stack_raw_unsafe(3);"
  +"const back=w.get_stack_raw_unsafe()>>>0;"
  +"if(back!==3) throw new Error('stack_raw readback '+back);"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return back;");
 try { return await bytesByOpcode(ctx); }
 finally {
  await ctx.call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_stack_raw_unsafe(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Which x86 opcodes produce the emitted wasm bytes the guest executes.
 *  Needs the per-opcode census engine (prepare-emitted-bytes-by-opcode.mjs). The Stage-0 census
 *  fixed the target at ~28% of executed bytes; this names where they are, which is the difference
 *  between a work order and an adjective. */
export async function bytesByOpcode({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const NAME=op=>{
  if(op>=0x100){const o=op-0x100;
   if(o>=0x80&&o<=0x8F)return '0F Jcc rel32';
   if(o>=0x90&&o<=0x9F)return '0F SETcc';
   if(o>=0x40&&o<=0x4F)return '0F CMOVcc';
   if(o===0xB6||o===0xB7)return '0F MOVZX';
   if(o===0xBE||o===0xBF)return '0F MOVSX';
   if(o===0xAF)return '0F IMUL r,rm';
   if(o>=0x10&&o<=0x17)return '0F SSE mov';
   if(o>=0x58&&o<=0x5F)return '0F SSE arith';
   if(o>=0x28&&o<=0x2F)return '0F SSE mov/cvt';
   return '0F '+o.toString(16).toUpperCase();}
  const T={0x88:'MOV rm8,r8',0x89:'MOV rm,r',0x8A:'MOV r8,rm8',0x8B:'MOV r,rm',0x8D:'LEA',
   0xC6:'MOV rm8,imm',0xC7:'MOV rm,imm',0x50:'PUSH r',0x58:'POP r',0xFF:'GRP5 (INC/DEC/CALL/JMP/PUSH)',
   0xE8:'CALL rel32',0xC3:'RET',0xC2:'RET imm16',0xEB:'JMP rel8',0xE9:'JMP rel32',
   0x83:'GRP1 rm,imm8',0x81:'GRP1 rm,imm32',0x80:'GRP1 rm8,imm8',0x84:'TEST rm8,r8',0x85:'TEST rm,r',
   0x3B:'CMP r,rm',0x39:'CMP rm,r',0x3D:'CMP eAX,imm',0x01:'ADD rm,r',0x03:'ADD r,rm',
   0x29:'SUB rm,r',0x2B:'SUB r,rm',0x31:'XOR rm,r',0x33:'XOR r,rm',0x21:'AND rm,r',0x23:'AND r,rm',
   0x09:'OR rm,r',0x0B:'OR r,rm',0xF6:'GRP3 rm8',0xF7:'GRP3 rm',0xD1:'GRP2 rm,1',0xC1:'GRP2 rm,imm8',
   0xD3:'GRP2 rm,CL',0x8F:'POP rm',0x68:'PUSH imm32',0x6A:'PUSH imm8',0xA1:'MOV eAX,moffs',
   0xA3:'MOV moffs,eAX',0xB8:'MOV r,imm32',0xD8:'x87 D8',0xD9:'x87 D9',0xDA:'x87 DA',0xDB:'x87 DB',
   0xDC:'x87 DC',0xDD:'x87 DD',0xDE:'x87 DE',0xDF:'x87 DF'};
  if(T[op])return T[op];
  if(op>=0x50&&op<=0x57)return 'PUSH r';
  if(op>=0x58&&op<=0x5F)return 'POP r';
  if(op>=0xB8&&op<=0xBF)return 'MOV r,imm32';
  if(op>=0x70&&op<=0x7F)return 'Jcc rel8';
  return '0x'+op.toString(16).toUpperCase();
 };
 await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.bytes_by_op_get) throw new Error('engine has no bytes_by_op_get');"
  +"w.set_dispatch_stats(1); w.bytes_by_op_reset();"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 try{
  await call('resume');note('Прогрев переписи байт по опкодам: 12 с');await sleep(12000);
  await call('evalWorker',"globalThis.preemption.getWasmExports().bytes_by_op_reset();return true;");
  const sb=await call('evalWorker',scene);
  note('Окно переписи: 10 с');await sleep(10000);
  const r=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return {bytes:Array.from({length:512},(_,i)=>w.bytes_by_op_get(i)),"
   +"counts:Array.from({length:512},(_,i)=>w.count_by_op_get(i))};");
  const sa=await call('evalWorker',scene);
  await call('pause');
  const rows=[];
  for(let i=0;i<512;i++) if(r.bytes[i]) rows.push({op:i,name:NAME(i),bytes:r.bytes[i],count:r.counts[i],
    perInsn:+(r.bytes[i]/Math.max(1,r.counts[i])).toFixed(1)});
  rows.sort((a,b)=>b.bytes-a.bytes);
  const totalBytes=rows.reduce((a,x)=>a+x.bytes,0),totalCount=rows.reduce((a,x)=>a+x.count,0);
  const top=rows.slice(0,20).map(x=>({...x,pct:+(100*x.bytes/totalBytes).toFixed(1)}));
  const out={totalBytes,totalCount,bytesPerInsn:+(totalBytes/totalCount).toFixed(2),
    distinct:rows.length,top,
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('bytes-by-opcode',out);
  note('всего '+out.bytesPerInsn+' байт/инструкцию в '+rows.length+' формах; топ: '
   +top.slice(0,8).map(x=>x.name+' '+x.pct+'% ('+x.perInsn+' б)').join(', ')+(out.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Decompose the guest bucket by emitted-code category, weighted by execution.
 *  Needs the census engine (prepare-emitted-bytes-census.mjs). Reports executed wasm bytes per
 *  retired x86 instruction, then re-measures with each removable category armed off; the drop is
 *  that category's byte share. Stage 0 of the x2 strategy, finally built. */
export async function emittedBytes({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const arm=async(expr)=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"+expr
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 const sample=async(label)=>{
  await call('resume');note(label+': прогрев 12 с');await sleep(12000);
  await call('evalWorker',"globalThis.preemption.getWasmExports().emit_bytes_reset();return true;");
  const sb=await call('evalWorker',scene);
  note(label+': окно 10 с');await sleep(10000);
  const r=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return {bytes:w.emit_bytes_get(0),insns:w.emit_bytes_get(1)};");
  const sa=await call('evalWorker',scene);
  await call('pause');
  return {label,bytesPerSecond:Math.round(r.bytes/10),insnsPerSecond:Math.round(r.insns/10),
    bytesPerInsn:r.insns?+(r.bytes/r.insns).toFixed(2):null,
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
 };
 await arm("if(!w.emit_bytes_get) throw new Error('engine has no emit_bytes_get'); w.set_dispatch_stats(1);");
 const rows=[];
 try{
  rows.push(await sample('базовый'));
  await arm("w.set_stack_raw_unsafe(3);");
  rows.push(await sample('без проверок памяти'));
  await arm("w.set_stack_raw_unsafe(0); if(w.jit_no_flag_tuple_set) w.jit_no_flag_tuple_set(1);");
  rows.push(await sample('без кортежа флагов'));
  const base=rows[0];
  const share=r=>base.bytesPerSecond?+(100*(1-r.bytesPerSecond/base.bytesPerSecond)).toFixed(1):null;
  const out={rows,guardByteShare:share(rows[1]),flagByteShare:share(rows[2]),
    bytesPerInsn:base.bytesPerInsn};
  await save('emitted-bytes',out);
  note('байт wasm на инструкцию x86: '+base.bytesPerInsn
   +'; доля байт у проверок памяти '+out.guardByteShare+'%, у кортежа флагов '+out.flagByteShare+'%');
 } finally {
  await call('pause').catch(()=>{});
  await arm("w.set_stack_raw_unsafe(0); if(w.jit_no_flag_tuple_set) w.jit_no_flag_tuple_set(0); w.set_dispatch_stats(0);").catch(()=>{});
 }
}

/** moduleEdges with block chaining (jit config 4) ARMED, so the chained-edge counter can prove
 *  the mechanism actually runs. A dead switch reports a null result indistinguishable from
 *  "no effect", and this one already looked dead once. */
export async function moduleEdgesChained(ctx){
 await ctx.call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"w.set_jit_config(4,1);"
  +"const back=w.get_jit_config(4)>>>0;"
  +"if(back!==1) throw new Error('idx4 readback '+back);"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return back;");
 try { return await moduleEdges(ctx); }
 finally {
  await ctx.call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_jit_config(4,0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Coverage for an amortized memory guard: what share of executed flat reads could ride on a
 *  previous read's widened guard instead of carrying their own. Needs the census engine
 *  (prepare-guard-group-census.mjs). This is the last unmeasured input to the only guard shape
 *  that three in-game measurements leave standing. */
export async function guardGroupCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.guard_group_get) throw new Error('engine has no guard_group_get');"
  +"w.set_dispatch_stats(1); w.guard_group_reset();"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 try{
  await call('resume');note('Прогрев переписи guard-групп: 12 с');await sleep(12000);
  await call('evalWorker',"globalThis.preemption.getWasmExports().guard_group_reset();return true;");
  const sb=await call('evalWorker',scene);
  note('Окно переписи: 10 с');await sleep(10000);
  const r=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return {anchors:w.guard_group_get(0),covered:w.guard_group_get(1)};");
  const sa=await call('evalWorker',scene);
  await call('pause');
  const total=r.anchors+r.covered;
  const row={anchors:r.anchors,covered:r.covered,total,
    coverage:total?r.covered/total:null,
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('guard-group-census',row);
  note('якорей '+r.anchors+', покрываемых '+r.covered+' → покрытие '
   +(100*(row.coverage??0)).toFixed(1)+'% (ВЕРХНЯЯ оценка)'+(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Which emission site produces the x87 ST-cache invalidations.
 *  Needs the per-site census engine (prepare-x87-inval-by-site.mjs). X87_CACHE_INVALIDATE is one
 *  scalar shared by ~18 sites, which is how an earlier reading mis-attributed 98% of it to MMX. */
export async function x87InvalSites({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const NAMES=['pop','push','fxch','fst'];
 await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.x87_inval_site_get) throw new Error('engine has no x87_inval_site_get');"
  +"w.set_dispatch_stats(1); w.set_jit_config(10,1); w.x87_inval_site_reset();"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 try{
  await call('resume');note('Прогрев переписи мест: 12 с');await sleep(12000);
  const zero=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.x87_inval_site_reset();"
   +"return Number(w.profiler_dispatch_stat_get(15));");
  const sb=await call('evalWorker',scene);
  note('Окно переписи мест: 10 с');await sleep(10000);
  const r=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return {sites:Array.from({length:4},(_,i)=>w.x87_inval_site_get(i)),"
   +"total:Number(w.profiler_dispatch_stat_get(15))};");
  const sa=await call('evalWorker',scene);
  await call('pause');
  const total=r.total-zero;
  const named=r.sites.reduce((a,b)=>a+b,0);
  const row={total,named,other:total-named,
    sites:Object.fromEntries(NAMES.map((n,i)=>[n,{count:r.sites[i],pct:+(100*r.sites[i]/Math.max(1,total)).toFixed(1)}])),
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('x87-inval-sites',row);
  note('всего '+total+'; '+NAMES.map((n,i)=>n+' '+row.sites[n].pct+'%').join(', ')
   +'; прочие '+(100*row.other/Math.max(1,total)).toFixed(1)+'%'+(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"w.set_jit_config(10,0); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** How many TRUE MMX instructions the guest retires per second, and which opcodes.
 *  Needs the census engine (prepare-mmx-opcode-census.mjs). Every one of these is emitted as a
 *  helper call while SSE gets inline v128, so this sizes an inline-SIMD lever before it is built. */
export async function mmxCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const NAMES={0x60:'PUNPCKLBW',0x61:'PUNPCKLWD',0x62:'PUNPCKLDQ',0x63:'PACKSSWB',0x64:'PCMPGTB',
  0x65:'PCMPGTW',0x66:'PCMPGTD',0x67:'PACKUSWB',0x68:'PUNPCKHBW',0x69:'PUNPCKHWD',0x6A:'PUNPCKHDQ',
  0x6B:'PACKSSDW',0x6E:'MOVD mm',0x6F:'MOVQ mm',0x70:'PSHUFW',0x71:'PS[RL]W grp',0x72:'PS[RL]D grp',
  0x73:'PS[RL]Q grp',0x74:'PCMPEQB',0x75:'PCMPEQW',0x76:'PCMPEQD',0x77:'EMMS',0x7E:'MOVD r/m',
  0x7F:'MOVQ store',0xD1:'PSRLW',0xD2:'PSRLD',0xD3:'PSRLQ',0xD4:'PADDQ',0xD5:'PMULLW',0xD6:'MOVDQ2Q',
  0xD7:'PMOVMSKB',0xD8:'PSUBUSB',0xD9:'PSUBUSW',0xDA:'PMINUB',0xDB:'PAND',0xDC:'PADDUSB',
  0xDD:'PADDUSW',0xDE:'PMAXUB',0xDF:'PANDN',0xE0:'PAVGB',0xE1:'PSRAW',0xE2:'PSRAD',0xE3:'PAVGW',
  0xE4:'PMULHUW',0xE5:'PMULHW',0xE7:'MOVNTQ',0xE8:'PSUBSB',0xE9:'PSUBSW',0xEA:'PMINSW',0xEB:'POR',
  0xEC:'PADDSB',0xED:'PADDSW',0xEE:'PMAXSW',0xEF:'PXOR',0xF1:'PSLLW',0xF2:'PSLLD',0xF3:'PSLLQ',
  0xF4:'PMULUDQ',0xF5:'PMADDWD',0xF6:'PSADBW',0xF7:'MASKMOVQ',0xF8:'PSUBB',0xF9:'PSUBW',
  0xFA:'PSUBD',0xFB:'PSUBQ',0xFC:'PADDB',0xFD:'PADDW',0xFE:'PADDD'};
 await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.mmx_census_get) throw new Error('engine has no mmx_census_get');"
  +"w.set_dispatch_stats(1); w.mmx_census_reset();"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 try{
  await call('resume');note('Прогрев переписи MMX: 12 с');await sleep(12000);
  await call('evalWorker',"globalThis.preemption.getWasmExports().mmx_census_reset();return true;");
  const sb=await call('evalWorker',scene);
  note('Окно переписи MMX: 10 с');await sleep(10000);
  const hist=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return Array.from({length:256},(_,i)=>w.mmx_census_get(i));");
  const sa=await call('evalWorker',scene);
  await call('pause');
  const rows=[];
  for(let i=0;i<256;i++) if(hist[i]) rows.push({op:'0x'+i.toString(16).toUpperCase(),name:NAMES[i]||'?',count:hist[i]});
  rows.sort((a,b)=>b.count-a.count);
  const total=rows.reduce((a,r)=>a+r.count,0);
  const frames=sa.serial-sb.serial;
  const row={total,perSecond:Math.round(total/10),distinct:rows.length,frames,
    perFrame:Math.round(total/Math.max(1,frames)),
    top:rows.slice(0,15).map(r=>({...r,pct:+(100*r.count/total).toFixed(1)})),
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover&&frames>50};
  await save('mmx-census',row);
  note('MMX всего '+total+' за 10 с ('+row.perSecond+'/с, '+row.perFrame+'/кадр) в '+rows.length
   +' опкодах; топ: '+row.top.slice(0,8).map(r=>r.name+' '+r.pct+'%').join(', ')+(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports(); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Name the x87 opcodes that fall off the relaxed fast path, by execution count.
 *  Needs the census engine (prepare-x87-uncovered-census.mjs); refuses on any other build. */
export async function x87Uncovered({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const read=()=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.x87_uncovered_get) throw new Error('engine has no x87_uncovered_get');"
  +"return Array.from({length:128},(_,i)=>w.x87_uncovered_get(i));");
 await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"w.set_dispatch_stats(1); w.set_jit_config(10,1); w.x87_uncovered_reset();"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
  +"return true;");
 try{
  await call('resume');note('Прогрев с переписью x87: 12 с');await sleep(12000);
  await call('evalWorker',"globalThis.preemption.getWasmExports().x87_uncovered_reset();return true;");
  const invalBefore=await call('evalWorker',
    "return Number(globalThis.preemption.getWasmExports().profiler_dispatch_stat_get(15));");
  const sb=await call('evalWorker',scene);
  note('Окно переписи опкодов: 10 с');await sleep(10000);
  const hist=await read(),sa=await call('evalWorker',scene);
  // The same edge also fires for MMX, which aliases fpu_st storage and has no 0xD8..0xDF
  // opcode to key on. Total invalidations MINUS the x87 histogram is therefore the MMX share,
  // and it is the only way to tell "the relaxed path misses opcodes" from "MMX wipes the cache".
  const inval=await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"return Number(w.profiler_dispatch_stat_get(15));")-invalBefore;
  await call('pause');
  const names={0:'FADD',1:'FMUL',2:'FCOM',3:'FCOMP',4:'FSUB',5:'FSUBR',6:'FDIV',7:'FDIVR'};
  const rows=[];
  for(let i=0;i<128;i++){
   if(!hist[i])continue;
   const op=0xD8+(i>>4), reg=(i>>1)&7, regForm=(i&1)===1;
   rows.push({slot:i,opcode:'0x'+op.toString(16).toUpperCase(),reg,form:regForm?'reg':'mem',
     name:(op===0xD8||op===0xDC)?names[reg]:'',count:hist[i]});
  }
  rows.sort((a,b)=>b.count-a.count);
  const total=rows.reduce((a,r)=>a+r.count,0);
  const row={total,invalTotal:inval,mmxShare:inval?1-total/inval:null,
    top:rows.slice(0,20).map(r=>({...r,pct:+(100*r.count/total).toFixed(1)})),
    distinct:rows.length,valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('x87-uncovered',row);
  note('сбросов всего '+inval+', из них x87 '+total+' ('+rows.length+' форм), MMX-доля '
    +(100*(row.mmxShare??0)).toFixed(1)+'%; топ x87: '
    +row.top.slice(0,6).map(r=>r.opcode+'/'+r.reg+' '+r.form+' '+r.pct+'%').join(', ')
    +(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"w.set_jit_config(10,0); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;").catch(()=>{});
 }
}

/** Does the x87 ST-local cache (jit config 10) actually hold in a race?
 *
 *  The invalidation is already narrowed to x87/MMX instructions whose wrapper did not keep the
 *  cache coherent — i.e. to x87 opcodes the relaxed fast path does NOT cover. So the hit/invalidate
 *  ratio says whether the cache is worth having at all, and if it is not, WHY: too few covered
 *  opcodes rather than too many foreign instructions. Nothing else separates those two. */
export async function x87CacheCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const stats=()=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"return {hit:Number(w.profiler_dispatch_stat_get(13)),fill:Number(w.profiler_dispatch_stat_get(14)),"
  +"inval:Number(w.profiler_dispatch_stat_get(15))};");
 const prev=await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"const p={stats:w.get_dispatch_stats(),x87:w.get_jit_config(10)>>>0};"
  +"w.set_dispatch_stats(1); w.set_jit_config(10,1);"
  +"if(w.get_jit_config(10)>>>0!==1) throw new Error('idx10 readback');"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
  +"return p;");
 try{
  await call('resume');note('Прогрев с x87-локалами: 12 с');await sleep(12000);
  const b=await stats(),sb=await call('evalWorker',scene);
  note('Окно переписи x87: 10 с');await sleep(10000);
  const a=await stats(),sa=await call('evalWorker',scene);
  await call('pause');
  const hit=a.hit-b.hit,fill=a.fill-b.fill,inval=a.inval-b.inval;
  const row={hit,fill,inval,hitRate:hit+fill?hit/(hit+fill):null,
    invalPerHit:hit?inval/hit:null,
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
  await save('x87-cache-census',{...row,prev});
  note('x87: попаданий '+hit+', заполнений '+fill+', сбросов '+inval
    +' → hit '+(100*(row.hitRate??0)).toFixed(1)+'%, сбросов на попадание '+(row.invalPerHit??0).toFixed(2)
    +(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"w.set_jit_config(10,0); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
   +"return true;").catch(()=>{});
 }
}

/** Differential for the incremental stage window: every reused stage is ALSO resolved the long
 *  way and the two views compared. A wrong texture here is invisible downstream - the frame
 *  still submits and still looks like a frame - so this counter is the only thing that can
 *  refuse the feature. */
export async function stagePartialVerify({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const perf=async()=>(await call('dbgCall','d3d9Perf')).backend;
 await call('evalWorker',"globalThis.__noD3D9StagePartial=false;globalThis.__d3d9VerifyStagePartial=true;return true;");
 try{
  await call('resume');note('Прогрев с дифференциалом: 8 с');await sleep(8000);
  const b=await perf(),sb=await call('evalWorker',scene);
  note('Окно дифференциала: 12 с');await sleep(12000);
  const a=await perf(),sa=await call('evalWorker',scene);
  await call('pause');
  const d=k=>(a[k]??0)-(b[k]??0);
  const frames=sa.serial-sb.serial;
  const row={frames,reuse:d('stageReuse'),resolve:d('stageResolve'),mismatch:d('stageReuseMismatch'),
    reusePerFrame:+(d('stageReuse')/Math.max(1,frames)).toFixed(1),
    resolvePerFrame:+(d('stageResolve')/Math.max(1,frames)).toFixed(1),
    valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover&&frames>50};
  await save('stagepartial-verify',row);
  note('переиспользовано '+row.reuse+', пересчитано '+row.resolve+', РАСХОЖДЕНИЙ '+row.mismatch+(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',"globalThis.__d3d9VerifyStagePartial=false;return true;").catch(()=>{});
 }
}

/** Hit rate of the permission-bitmap read probe, in a validated race window.
 *
 *  The probe is the SAFE shape of the raw-read ceiling (stackraw3, +10.1%): it answers the same
 *  permission question from a per-page byte instead of the TLB chain. It measured -3.7% in game,
 *  which has two very different explanations - the probe is genuinely not cheaper, or it almost
 *  never hits and every access pays probe AND chain. The counters separate them, and nothing
 *  else can: a miss costs time and increments no timing instrument. */
export async function permMapCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const stats=()=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"return {hit:Number(w.profiler_dispatch_stat_get(25)),miss:Number(w.profiler_dispatch_stat_get(26))};");
 const prev=await call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"
  +"if(!w.set_perm_map_reads) throw new Error('engine has no set_perm_map_reads');"
  +"const p={stats:w.get_dispatch_stats(),perm:w.get_perm_map_reads()>>>0};"
  +"w.set_dispatch_stats(1); w.set_perm_map_reads(1);"
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
  +"return p;");
 try{
  await call('resume');note('Прогрев с включённым perm-map: 12 с');await sleep(12000);
  const before=await stats(),sceneBefore=await call('evalWorker',scene);
  note('Окно переписи: 10 с');await sleep(10000);
  const after=await stats(),sceneAfter=await call('evalWorker',scene);
  await call('pause');
  const hit=after.hit-before.hit,miss=after.miss-before.miss;
  const row={hit,miss,total:hit+miss,hitRate:hit+miss?hit/(hit+miss):null,
    valid:valid(sceneBefore)&&valid(sceneAfter)&&sceneAfter.mover>sceneBefore.mover};
  await save('permmap-census',{...row,prev});
  note('perm-map: попаданий '+hit+', промахов '+miss+' → '+(100*(row.hitRate??0)).toFixed(2)+'%'+(row.valid?'':' (ОТКЛОНЕНО)'));
 } finally {
  await call('pause').catch(()=>{});
  await call('evalWorker',
    "const w=globalThis.preemption.getWasmExports();"
   +"w.set_perm_map_reads("+0+"); w.set_dispatch_stats(0);"
   +"if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
   +"return true;").catch(()=>{});
 }
}
export async function permMapAb(ctx){ return leverAb(ctx,'permmap'); }
export async function comboAllAb(ctx){ return leverAb(ctx,'comboall'); }
export async function fastmemWritesAb(ctx){ return leverAb(ctx,'fastmemwrites'); }
/** N measurement windows with NO lever, each carrying its calibrator reading.
 *  For a per-boot lever (an engine binary) two runs are the only option; the calibrator is what
 *  makes them comparable — equal calibrators mean the same plateau, and only then may the two
 *  medians be divided. */
export async function windowsOnly(ctx){ return leverAb({...ctx,__windowsOnly:true},'none'); }

export async function stackRawAb(ctx){ return leverAb(ctx,'stackraw'); }

async function leverAb({call,save,note,sleep,scene},lever){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const setLever=async(mode)=>lever==='none'
  ? Promise.resolve(mode)
  : lever==='permmap'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" if(!w.set_perm_map_reads) throw new Error('engine has no set_perm_map_reads');"
    +" w.set_perm_map_reads("+mode+");"
    +" const back=w.get_perm_map_reads()>>>0;"
    +" if(back!=="+mode+") throw new Error('perm_map readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='blockchain'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_jit_config(4,"+mode+");"
    +" const back=w.get_jit_config(4)>>>0;"
    +" if(back!=="+mode+") throw new Error('idx4 readback '+back);"
    // A codegen input: blocks compiled before the flip carry the old exit shape.
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='targetsize'
  ? call('evalWorker',
     "globalThis.__noD3D9TargetSizeCache="+(mode===0)+";"
    +" return globalThis.__noD3D9TargetSizeCache?0:1;")
  : lever==='stagepartial'
  ? call('evalWorker',
     "globalThis.__noD3D9StagePartial="+(mode===0)+";"
    +" return globalThis.__noD3D9StagePartial?0:1;")
  : lever==='stagewindow'
  ? call('evalWorker',
     "globalThis.__d3d9ForceStageWindow="+(mode===1)+";"
    +" return globalThis.__d3d9ForceStageWindow?1:0;")
  : lever==='capmemo'
  ? call('evalWorker',
     "globalThis.__d3d9ForceCaptureMemo="+(mode===1)+";"
    +" return globalThis.__d3d9ForceCaptureMemo?1:0;")
  : lever==='comboall'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_stack_raw_unsafe("+(mode?3:0)+");"
    +" globalThis.__d3d9ForceCaptureMemo="+(mode===1)+";"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" const a=w.get_stack_raw_unsafe()>>>0;"
    +" if(a!=="+(mode?3:0)+") throw new Error('stack_raw readback '+a);"
    +" return "+mode+";")
  : lever==='combo'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_stack_raw_unsafe("+(mode?3:0)+");"
    +" if(w.jit_no_flag_tuple_set) w.jit_no_flag_tuple_set("+(mode?1:0)+");"
    +" const a=w.get_stack_raw_unsafe()>>>0, b=w.jit_no_flag_tuple_get?w.jit_no_flag_tuple_get()>>>0:0;"
    +" if(a!=="+(mode?3:0)+"||b!=="+(mode?1:0)+") throw new Error('combo readback '+a+'/'+b);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return "+mode+";")
  : lever==='fastmemwrites'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_jit_config(19,"+mode+");"
    +" const back=w.get_jit_config(19)>>>0;"
    +" if(back!=="+mode+") throw new Error('idx19 readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : (lever==='stackraw2'||lever==='stackraw3')
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" if(!w.set_stack_raw_unsafe) throw new Error('engine has no set_stack_raw_unsafe');"
    +" w.set_stack_raw_unsafe("+mode+");"
    +" const back=w.get_stack_raw_unsafe()>>>0;"
    +" if(back!=="+mode+") throw new Error('stack_raw readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='flagtuple'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" if(!w.jit_no_flag_tuple_set) throw new Error('engine has no jit_no_flag_tuple_set');"
    +" w.jit_no_flag_tuple_set("+mode+");"
    +" const back=w.jit_no_flag_tuple_get()>>>0;"
    +" if(back!=="+mode+") throw new Error('flag-tuple readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='x87locals'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_jit_config(10,"+mode+");"
    +" const back=w.get_jit_config(10)>>>0;"
    +" if(back!=="+mode+") throw new Error('idx10 readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='flaglocals'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" w.set_jit_config(21,"+mode+");"
    +" const back=w.get_jit_config(21)>>>0;"
    +" if(back!=="+mode+") throw new Error('idx21 readback '+back);"
    // A codegen input: blocks compiled before the flip carry the old shape, so the cache
    // must go or the arm measures a mixture of both.
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;")
  : lever==='eaglcursor'
  ? call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" if(!w.eagl_read_cursor_set_policy) throw new Error('engine has no eagl_read_cursor_set_policy');"
    +" w.eagl_read_cursor_set_policy("+mode+");"
    +" const back=w.eagl_read_cursor_get_policy()>>>0;"
    +" if(back!=="+mode+") throw new Error('policy readback '+back);"
    +" w.eagl_read_cursor_reset_stats();"
    +" return back;")
  : lever==='bankhash'
  ? call('evalWorker',
     "globalThis.__d3d9NoBankHashCache="+(mode===0)+";"
    +" return globalThis.__d3d9NoBankHashCache?0:1;")
  : lever==='relaxedfpu'
  ? call('evalWorker',
     "const pm=globalThis.preemption;"
    +" if(!pm||!pm.setRelaxedFpu) throw new Error('no PreemptionManager.setRelaxedFpu');"
    +" pm.setRelaxedFpu("+(mode===1)+");"
    +" const back=pm.isRelaxedFpuEnabled()?1:0;"
    +" if(back!=="+mode+") throw new Error('relaxedFpu readback '+back);"
    +" return back;")
  : call('evalWorker',
     "const w=globalThis.preemption.getWasmExports();"
    +" if(!w.set_stack_raw_unsafe) throw new Error('engine exports no set_stack_raw_unsafe');"
    +" w.set_stack_raw_unsafe("+mode+");"
    +" const back=w.get_stack_raw_unsafe()>>>0;"
    +" if(back!=="+mode+") throw new Error('stack_raw readback '+back);"
    +" if(w.jit_clear_cache_js) w.jit_clear_cache_js();"
    +" return back;");
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 // CALIBRATOR. The stand sits on ~5-minute plateaus that move FPS by ±30% at identical
 // per-frame work, and a plateau outlasts an ABBA quartet — so raw FPS cannot be compared
 // across windows. A fixed deterministic workload timed in the SAME worker measures the
 // plateau itself; dividing by it is what makes two windows comparable.
 const calibrate=async()=>{
  // MEDIAN, not min: the minimum is the best-case clock rate and is exactly what filters out
  // the CPU contention that forms a plateau. The median of the reps is what tracks it.
  const r=await call('evalWorker',
    "const xs=[];"
   +"for(let rep=0;rep<9;rep++){"
   +" const t0=performance.now();"
   +" let h=0x811c9dc5;"
   +" for(let i=0;i<2000000;i++){h=Math.imul(h^i,0x01000193)>>>0;}"
   +" xs.push(performance.now()-t0);"
   +" if(h===0x12345678)xs.push(-1);"
   +"}"
   +"xs.sort((a,b)=>a-b);"
   +"return {median:xs[(xs.length-1)>>1],min:xs[0],max:xs[xs.length-1]};");
  if(!(r&&r.median>0))throw Error('calibrator returned '+JSON.stringify(r));
  return r.median;
 };
 await save(lever+'-start',{initial,lever});
 const order=lever==='none'?[0,0,0,0,0,0,0,0,0,0,0,0]:lever==='stackraw2'?[0,2,2,0,2,0,0,2,2,0,0,2,2,0,2,0]:lever==='stackraw3'?[0,3,3,0,3,0,0,3,3,0,0,3,3,0,3,0]:((globalThis.__leverOrder)||[0,1,1,0,1,0,0,1,1,0,0,1,1,0,1,0]);
 const windows=[];
 try{
  for(let i=0;i<order.length;i++){
   const mode=order[i];
   await call('pause');
   const applied=await setLever(mode);
   if(applied!==mode)throw Error('lever not applied');
   await call('resume');
   note('Рука '+(i+1)+'/'+order.length+' ('+lever+'='+mode+'): прогрев 12 с');
   await sleep(12000);
   await call('evalWorker','System.getInstance().services.render.resetFlipCadence();return true;');
   const calibBefore=await calibrate();
   const before=await call('evalWorker',scene);
   const perfBefore=(await call('dbgCall','d3d9Perf')).backend;
   note('Окно '+(i+1)+': 15 с');
   await sleep(15000);
   const after=await call('evalWorker',scene);
   const perfAfter=(await call('dbgCall','d3d9Perf')).backend;
   const calibAfter=await calibrate();
   const calib=(calibBefore+calibAfter)/2;
   // WHERE the lost time goes when a plateau drops: the calibrator says it is not the host CPU,
   // so the split between guest execution, our thunks, GPU and present is what names the owner.
   const split=await call('perfStats').catch(()=>null);
   const raw=after.raw,frames=after.serial-before.serial;
   const ok=valid(before)&&valid(after)&&after.mover>before.mover&&frames>50
     &&(raw.length===frames||raw.length===frames-1)
     &&after.guestSerial-before.guestSerial===frames&&before.source===after.source;
   const total=raw.reduce((a,b)=>a+b,0);
   // Proof the lever DID something: an arm whose work counters match the other arm's is a
   // dead switch reporting a null result, which is indistinguishable from "no effect".
   const hashedWords=(perfAfter.captureHashedWords-perfBefore.captureHashedWords)/Math.max(1,frames);
   const per=(k)=>+(((perfAfter[k]??0)-(perfBefore[k]??0))/Math.max(1,frames)).toFixed(1);
   const row={index:i,mode,valid:ok,frames,hashedWordsPerFrame:+hashedWords.toFixed(0),
     progConstWrites:per('progConstWrites'),progConstReuseHits:per('progConstReuseHits'),
     memoHits:per('captureMemoHits'),memoMisses:per('captureMemoMisses'),
     pipelineSets:per('pipelineSets'),bindGroupBuilds:per('bindGroupBuilds'),
     stageHits:per('stageWindowHits'),stageMisses:per('stageWindowMisses'),
     fps:raw.length*1000/total,calibMs:+calib.toFixed(2),
     split:split&&split.average?{...split.average.categories,frameMs:split.average.frameMs}:null,
     gpuErrors:split?split.spikeCount:null,
     calibSpreadPct:+(100*Math.abs(calibAfter-calibBefore)/calib).toFixed(1),
     moverPerFrame:(after.mover-before.mover)/frames,compile:[before.compile,after.compile]};
   windows.push(row);
   await save(lever+'-window',{...row,lever,before,after,raw});
   note('Рука '+(i+1)+': '+row.fps.toFixed(2)+' FPS · калибратор '+row.calibMs+' мс'+(ok?'':' (ОТКЛОНЕНО)'));
  }
 } finally {
  await call('pause').catch(()=>{});
  await setLever(lever==='relaxedfpu'?1:0).catch(()=>{});
 }
 const good=windows.filter(w=>w.valid);
 const med=xs=>{const v=[...xs].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
 const off=good.filter(w=>w.mode===0).map(w=>w.fps),on=good.filter(w=>w.mode!==0).map(w=>w.fps);
 // Normalised FPS: fps x (calibrator / median calibrator). A window that ran on a slow plateau
 // has a LONGER calibrator, so multiplying restores it to the reference plateau.
 const calibs=good.map(w=>w.calibMs).filter(x=>typeof x==='number');
 const calibRef=calibs.length?med(calibs):null;
 const norm=w=>calibRef?w.fps*(w.calibMs/calibRef):w.fps;
 const offN=good.filter(w=>w.mode===0).map(norm),onN=good.filter(w=>w.mode!==0).map(norm);
 const summary={order,windows,rejected:windows.length-good.length,
   medianOff:off.length?med(off):null,medianOn:on.length?med(on):null,
   ratio:off.length&&on.length?med(on)/med(off):null,
   calibRef,medianOffNorm:offN.length?med(offN):null,medianOnNorm:onN.length?med(onN):null,
   ratioNorm:offN.length&&onN.length?med(onN)/med(offN):null,
   note:'In-boot paired windows, JIT cache cleared and re-warmed on every switch. Directional unless it clears the identity-control spread.'};
 await save(lever+'-summary',{...summary,lever});
 note(lever+': off '+(summary.medianOff??0).toFixed(2)+' · on '+(summary.medianOn??0).toFixed(2)+' · ratio '+(summary.ratio??0).toFixed(4));
}

/** Retired-instruction class census over a validated race window.
 *
 *  The per-family gap measured on the codegen-pair demo is uneven (integer/pointer ~10x, x87
 *  63x), so the size of an x87 lever is decided by the game's OWN class shares, not by the
 *  demo's. Arming clears the JIT cache, so the window is warmed after arming, and the verb
 *  reports coverage against the retired counter — a table covering part of the guest is
 *  labelled as such rather than read as the whole.
 */
export async function opcodeShare({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const armed=await call('opcodeCensusArm');
 await save('opcode-armed',armed);
 await call('resume');
 note('Прогрев после сброса JIT-кэша: 15 с');await sleep(15000);
 await call('opcodeCensusMark');
 note('Окно цензуса: 20 с');await sleep(20000);
 const report=await call('opcodeCensus',{top:40});
 await call('pause');
 await save('opcode-census',{report,scene:await call('evalWorker',scene)});
 note('Цензус классов снят');
 return report;
}

/** Per-draw accounting for the D3D9 capture path (strategy stage 0.2).
 *
 *  The constant-bank content hash is the hottest JS leaf in a race trace, but whether it is
 *  worth attacking depends on the capture memo's MISS rate and on how many words a miss walks.
 *  Neither was counted before. Reported over a WINDOW (difference of two snapshots), because
 *  the counters are cumulative since boot and a total handed back under a fresh label is how a
 *  previous configuration's work gets read as this one's.
 */
export async function drawAccounting({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 // dbg.d3d9Perf merges each device's subsystem counters into the snapshot; reading the
 // d3d9-perf module directly misses that merge and reported 0 draws next to 2069 captures.
 const arena=async()=>call('evalWorker',
   "return import('/src/worker/backends/webgpu/d3d9/d3d9-wasm-arena.ts').then(m=>({"
  +" initialized:m.d3d9WasmArena.isInitialized(),"
  +" stats:m.d3d9WasmArena.getStats?m.d3d9WasmArena.getStats():null})).catch(e=>({error:String(e)}));");
 // WBUF pair-run detection is the PRECONDITION for every batching path: no runs, no
 // MegaBatch and no render bundles, and both then report zero without reporting a reason.
 const wbuf=async()=>{const p=await call('dbgCall','d3d9Perf');return p&&p.wbuf?{...p.wbuf}:null;};
 const snap=async()=>({backend:{...(await call('dbgCall','d3d9Perf')).backend},
   serial:await call('evalWorker','return System.getInstance().services.render.getPresentSerial();')});
 await call('resume');
 note('Прогрев: 10 с');await sleep(10000);
 const before=await snap();
 note('Окно учёта draw-путей: 20 с');await sleep(20000);
 const after=await snap();
 await call('pause');
 if(!before.backend||!after.backend)throw Error('d3d9 backend counters unavailable: '+JSON.stringify(before));
 const d={};for(const k of Object.keys(after.backend))d[k]=after.backend[k]-before.backend[k];
 // Executor metrics are RESET per frame by the executor itself, so a difference across a
 // 20 s window is meaningless for them: report the last frame's values, labelled as such.
 const frames=after.serial-before.serial;
 const per=(x)=>frames>0?+(x/frames).toFixed(1):null;
 const report={frames,delta:d,perFrame:{
   draws:per(d.drawCalls),captureMemoHits:per(d.captureMemoHits),captureMemoMisses:per(d.captureMemoMisses),
   hashedWords:per(d.captureHashedWords),progConstWrites:per(d.progConstWrites),progConstReuseHits:per(d.progConstReuseHits),
   bindGroupBuilds:per(d.bindGroupBuilds),pipelineSets:per(d.pipelineSets),
   renderBundleHits:per(d.renderBundleHits),renderBundleMisses:per(d.renderBundleMisses),
   captureConstOnly:per(d.captureConstOnly),batchRuns:per(d.batchRuns),batchRunDraws:per(d.batchRunDraws),batchRunsGe4:per(d.batchRunsGe4),
   megaBatchBatches:per(d.megaBatchBatches),megaBatchLogicalDraws:per(d.megaBatchLogicalDraws),
   megaBatchPhysicalDraws:per(d.megaBatchPhysicalDraws),megaBatchFallbacks:per(d.megaBatchFallbacks),
   megaRejectShape:per(d.megaBatchRejectShape),megaRejectLimits:per(d.megaBatchRejectLimits),
   megaRejectConstants:per(d.megaBatchRejectConstants),megaRejectVsLength:per(d.megaBatchRejectVsLength)},
   memoHitPct:(d.captureMemoHits+d.captureMemoMisses)>0
     ? +(100*d.captureMemoHits/(d.captureMemoHits+d.captureMemoMisses)).toFixed(1):null,
   wordsPerMiss:d.captureMemoMisses>0?+(d.captureHashedWords/d.captureMemoMisses).toFixed(1):null,
};
 report.arena=await arena();
 report.wbuf=await wbuf();
 const perf=await call('dbgCall','d3d9Perf');
 report.skips=perf&&perf.skip?{...perf.skip}:null;
 report.api=perf&&perf.api?{...perf.api}:null;
 await save('draw-accounting',report);
 note('draws/кадр '+report.perFrame.draws+' · memo '+report.memoHitPct+'% · слов на промах '+report.wordsPerMiss);
 return report;
}

/** What the WBUF ring actually carries, in the live race.
 *
 *  Every batching path in the D3D9 backend is gated behind ONE registered pair shape
 *  (SetVertexShaderConstantF -> DrawIndexedPrimitive, exact alternation, >=2 pairs). The race
 *  reports 0 runs, 0 pairs AND 0 fallbacks, i.e. the shape never occurs — so the question is
 *  what the stream really looks like. The census is opt-in and answers null (not 0) until
 *  armed, so an unarmed read cannot be quoted as "never called".
 */
export async function wbufCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 await call('apiCensus',null,{reset:true});
 const armed=await call('apiCensus',null,{wbuf:true});
 await save('wbuf-census-armed',armed);
 await call('resume');
 note('Окно цензуса WBUF: 20 с');await sleep(20000);
 const rows=await call('apiCensus',null,{});
 const scene2=await call('evalWorker',scene);
 await call('pause');
 const list=(Array.isArray(rows)?rows:rows.calls||[]).filter(r=>r.wbufCount===null||r.wbufCount>0||r.count>0||r.fastPathCount>0);
 list.sort((a,b)=>(b.wbufCount??0)-(a.wbufCount??0));
 await save('wbuf-census',{top:list.slice(0,40),serial:scene2.serial});
 note('Цензус WBUF снят: '+list.length+' строк');
 return list.slice(0,25);
}

/** Correctness gate for the blocked constant-bank hash: run the race with the differential ON
 *  and confirm the cached key never disagrees with a full recompute. A stale key is silently
 *  wrong constants, so this must pass before any timing arm is believed. */
export async function bankHashVerify({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 await call('evalWorker','globalThis.__d3d9VerifyBankHash=true;return true;');
 await call('resume');
 note('Дифференциальная проверка хеша банка: 25 с');await sleep(25000);
 const perf=await call('dbgCall','d3d9Perf');
 const mism={mismatches:perf.backend.captureBankHashMismatch,
   hashedWords:perf.backend.captureHashedWords,misses:perf.backend.captureMemoMisses};
 await call('pause');
 await call('evalWorker','globalThis.__d3d9VerifyBankHash=false;return true;');
 const after=await call('evalWorker',scene);
 await save('bank-hash-verify',{mism,frames:after.serial-initial.serial});
 note('Расхождений хеша: '+JSON.stringify(mism));
 return mism;
}

/** High-ROI class first: is the GAME on a slow path because of an answer WE gave?
 *  Software vertex processing, shader versions it actually created, and the device caps it
 *  branched on. A wrong capability makes the title pick worse code, and no amount of draw-path
 *  micro-optimisation recovers that.
 */
export async function guestPathAudit({call,save,note,scene}){
 const initial=await call('evalWorker',scene);
 const info=await call('evalWorker',
   "const s=System.getInstance();"
  +"return import('/src/worker/modules/d3d9/index.ts').then(m=>{"
  +" const devs=m.d3d9Devices?[...m.d3d9Devices.values()]:null;"
  +" if(!devs||!devs.length) return {error:'no d3d9 devices exported'};"
  +" const d=devs[0];"
  +" return {swvp:d.softwareVertexProcessing,"
  +"  behaviorFlags:d.behaviorFlags??null,"
  +"  vsHandles:d.vertexShaderCount??null,"
  +"  counters:d.getCounters?d.getCounters():null};});").catch(e=>({error:String(e)}));
 await save('guest-path-audit',{info,scene:initial});
 note('Аудит пути: '+JSON.stringify(info).slice(0,200));
 return info;
}

/** The actual ORDER of calls on the WBUF ring. Counts said what the ring carries; only the
 *  order says what shape a run detector must match — and the one registered shape matches
 *  nothing (pairRuns/pairs/pairFallbacks all zero). Designing the detector from the averages
 *  would be designing for a stream that may not exist. */
export async function wbufOrder({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 await call('evalWorker','globalThis.__wbufSequenceOut=[];globalThis.__wbufSequence=600;return true;');
 await call('resume');await sleep(4000);await call('pause');
 const seq=await call('evalWorker',
   "const d=System.getInstance().process.dispatcher;"
  +"const ids=globalThis.__wbufSequenceOut||[];"
  +"const g=d.thunkGenerator;const names={};"
  // No funcId->name accessor exists; walk the generator's stubs once and invert the map.
  +"const all=(g&&g.getAllStubs)?g.getAllStubs():[];"
  +"for(const st of all){if(st&&st.functionId)names[st.functionId]=((st.dllName||'?')+':'+(st.functionName||'?'));}"
  +"return {ids:ids.slice(0,600),names};");
 await save('wbuf-order',seq);
 const short=(n)=>String(n).replace(/^d3d9:IDirect3DDevice9_/,'').replace(/^d3d9:/,'');
 const line=seq.ids.map(i=>short(seq.names[i])).slice(0,120).join(' ');
 note('Порядок снят: '+seq.ids.length+' записей');
 return line;
}

/** Turn every landed lever OFF (or ON) at once, for a trace comparison of the TOTAL.
 *  In-boot FPS cannot resolve a few percent on this stand, so the total is read from the
 *  trace's bucket composition instead; this verb only sets the switches and reports them back. */
export async function leversSet({call,save,note},on){
 const r=await call('evalWorker',
   "globalThis.__d3d9NoBankHashCache="+(!on)+";"
  +"return {bankHashCache:!globalThis.__d3d9NoBankHashCache};");
 await save('levers-set',{on,applied:r});
 note('Рычаги: '+JSON.stringify(r));
 return r;
}
export async function leversOn(ctx){ return leversSet(ctx,true); }
export async function leversOff(ctx){ return leversSet(ctx,false); }
