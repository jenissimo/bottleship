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
  // NEVER `if (w.fn) w.fn(...)`. The census engine does not carry jit_no_flag_tuple_set — only
  // prepare-flag-tuple-ablation / prepare-codegen-ceiling-combo build it — so from the day this
  // experiment was written the flag arm silently ran the BASELINE and both published numbers
  // (2.1%, and the 0.20% its bytes/insn recomputation gave) are baseline against baseline.
  // Demand the switch and read it back, the way codegen-bench.ts:139-141 already does.
  await arm("w.set_stack_raw_unsafe(0);"
   +"if(!w.jit_no_flag_tuple_set||!w.jit_no_flag_tuple_get) throw new Error("
   +"'engine has no jit_no_flag_tuple_set/get: build it with prepare-flag-tuple-ablation.mjs');"
   +"w.jit_no_flag_tuple_set(1);"
   +"if(w.jit_no_flag_tuple_get()>>>0!==1) throw new Error('flag-tuple readback');");
  rows.push({...await sample('без кортежа флагов'),
   armedReadback:await call('evalWorker',
     "return globalThis.preemption.getWasmExports().jit_no_flag_tuple_get()>>>0;")});
  const base=rows[0];
  // BYTES PER INSTRUCTION, not bytes per second. Removing bytes makes the guest retire MORE
  // instructions per second, so a per-second denominator reads part of the speed-up as a byte
  // saving — and reads a slower arm as one too. Proof it matters, from the stack-class run:
  // knob modes 2 and 3 emit identical code (68.71 vs 68.75 B/insn, one call site in codegen.rs)
  // and per-second reports them 0.83 pp apart. Per-second is kept, labelled, for continuity.
  const share=r=>base.bytesPerInsn?+(100*(1-r.bytesPerInsn/base.bytesPerInsn)).toFixed(2):null;
  const perSecond=r=>base.bytesPerSecond?+(100*(1-r.bytesPerSecond/base.bytesPerSecond)).toFixed(2):null;
  const out={rows,guardByteShare:share(rows[1]),flagByteShare:share(rows[2]),
    bytesPerInsn:base.bytesPerInsn,
    contaminated:{note:'bytes/second denominator, kept only to compare with pre-2026-09-11 records',
      guardByteShare:perSecond(rows[1]),flagByteShare:perSecond(rows[2])}};
  await save('emitted-bytes',out);
  note('байт wasm на инструкцию x86: '+base.bytesPerInsn
   +'; доля байт у проверок памяти '+out.guardByteShare+'%, у кортежа флагов '+out.flagByteShare+'%'
   +' (по байтам/с, загрязнённо: '+out.contaminated.guardByteShare+'% / '
   +out.contaminated.flagByteShare+'%)');
 } finally {
  await call('pause').catch(()=>{});
  await arm("w.set_stack_raw_unsafe(0); w.set_dispatch_stats(0);"
   +"if(w.jit_no_flag_tuple_set) w.jit_no_flag_tuple_set(0);").catch(()=>{});
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
 // The previous version of this verb set globalThis.__wbufSequence / __wbufSequenceOut, which
 // NOTHING in src/ reads, then reported `ids.length` as a successful capture — so it printed
 // "0 записей" and that zero read like a statement about the ring. The real mechanism is
 // ThunkDispatcher.armWriteBufSequence / getWriteBufSequence, reached through
 // d3d9Perf({wbufSequence: N}); getWriteBufSequence returns NAMES already and answers null
 // while unarmed, precisely so a disarmed capture cannot answer [] and read as "nothing ran".
 // Armed and read through `apiCensus` — the harness verb that owns this dispatcher pair
 // (`state.ts:414`). Arming returns early with {wbufSequence:"armed"}; the capture is read by
 // calling again, and `getWriteBufSequence` answers null while unarmed precisely so a disarmed
 // read cannot come back as [] and be mistaken for an empty ring.
 const WANT=4000;
 const armed=await call('apiCensus',{wbufSequence:WANT});
 if(armed?.wbufSequence!=='armed')throw Error('wbufSequence did not arm: '+JSON.stringify(armed));
 await call('resume');note('Снимаю последовательность кольца: '+WANT+' записей');
 await sleep(6000);
 await call('pause');
 const census=await call('apiCensus');
 const seq=census?.wbufSequence;
 if(!seq)throw Error('wbufSequence came back null: the capture was never armed on this dispatcher');
 if(!seq.ids||!seq.ids.length)throw Error('capture armed but empty — the ring produced nothing in '
  +'the window (want '+WANT+', still armed: '+seq.armed+')');
 await save('wbuf-order',{want:WANT,captured:seq.ids.length,stillArmed:seq.armed,ids:seq.ids});
 const short=n=>String(n).replace(/^d3d9:IDirect3DDevice9_/,'').replace(/^d3d9:/,'');
 const names=seq.ids.map(short);
 const tally={};for(const n of names)tally[n]=(tally[n]||0)+1;
 const top=Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,8);
 note('Порядок снят: '+names.length+' записей, '+Object.keys(tally).length+' различных; топ: '
  +top.map(([n,c])=>n+' '+c).join(', '));
 return {captured:names.length,distinct:Object.keys(tally).length,top};
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


/** Measurement 2 of the perf campaign: the stack-access census, split ESP-only / EBP-in-window /
 *  EBP-out-of-window, execution-weighted over a validated race window — and, in the SAME boot,
 *  the executed-wasm-byte share that the stack-fastmem knob actually removes at each mode.
 *
 *  What it decides (v86-emitter-target-architecture.md §3 lever 2 step (a)): the mode-1 ceiling.
 *  The knob admits base ESP **or EBP** (modrm.rs:21-26), but a window proven around ESP says
 *  nothing about an EBP-based access in /Oy code — so the knob's ceiling is an upper bound on an
 *  unsound superset. The ESP-only share is the honest ceiling; the EBP distance bands say how
 *  much of the rest a cheap in-window proof could reach.
 *
 *  TWO INSTRUMENTS, ONE PREDICTION. The class census counts READS; the byte census counts
 *  EXECUTED WASM BYTES. Mode 1 and mode 2 elide the identical per-read guard sequence over
 *  different populations, so their byte shares must stand in the ratio the READ counts predict:
 *
 *      byteShare(mode1) / byteShare(mode2)  ==  (espW32 + ebpW32) / (espW32 + ebpW32 + otherW32)
 *
 *  Only 32-bit reads appear because `stack_raw_applies` is reached from
 *  `gen_modrm_resolve_safe_read32` alone. A census that mis-assigned a class and a byte counter
 *  that measured the wrong arm would both have to be wrong in the SAME direction to pass this.
 *
 *  The class census runs on its own switch so its own emitted increments are not counted as
 *  executed bytes. Needs the combined census engine (prepare-stack-class-census.mjs). */
export async function stackClassCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');
 const NAMES=['readEspTotal','readEspW8','readEspW16','readEspW32','readEspW64','readEspW128',
  'readEbpTotal','readEbpW8','readEbpW16','readEbpW32','readEbpW64','readEbpW128',
  'readEbpNear4k','readEbpNear64k','readEbpNear1m','readEbpFar',
  'readOtherTotal','readIneligible','readEspDispNeg','readEspDispGe4k','readTotal',
  'readOtherW32','readOtherW64','readOtherW128',
  'stackPopRead32','stackLeaveRead','stackLeaveNear64k','stackPushWrite32'];
 const arm=expr=>call('evalWorker',
   "const w=globalThis.preemption.getWasmExports();"+expr
  +"if(w.jit_clear_cache_js) w.jit_clear_cache_js(); return true;");
 /** Warm, zero the counters, hold a 10 s window, read them back — with scene validity on both
  *  sides so an arm that left the race is refused rather than averaged in. */
 const window10=async(label,zero,read)=>{
  await call('resume');note(label+': прогрев 12 с');await sleep(12000);
  await call('evalWorker',zero);
  const sb=await call('evalWorker',scene);
  note(label+': окно 10 с');await sleep(10000);
  const r=await call('evalWorker',read);
  const sa=await call('evalWorker',scene);
  await call('pause');
  return {r,valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
 };
 await arm(
   "if(!w.stack_class_get) throw new Error('engine has no stack_class_get');"
  +"if(!w.emit_bytes_get) throw new Error('engine has no emit_bytes_get');"
  +"if(w.get_jit_config(21)) throw new Error('flag locals (idx 21) must be OFF: the class census "
  +"emits if/else, which is a flag boundary');"
  +"w.set_stack_raw_unsafe(0); w.set_dispatch_stats(1);"
  +"w.set_stack_class_census(1); w.stack_class_reset();"
  +"if(w.get_stack_class_census()!==1) throw new Error('class census switch did not take');");
 try{
  // arm 1: the class census
  const a1=await window10('перепись классов стека',
   "const w=globalThis.preemption.getWasmExports();"
   +"w.stack_class_reset(); w.emit_bytes_reset(); return true;",
   "const w=globalThis.preemption.getWasmExports();"
   +"return {slots:Array.from({length:28},(_,i)=>w.stack_class_get(i)),"
   +"insns:w.emit_bytes_get(1)};");
  const c=Object.fromEntries(NAMES.map((n,i)=>[n,a1.r.slots[i]]));
  // Instructions retired in the SAME window as the class counts, so reads-per-instruction is a
  // measured ratio rather than two numbers from two arms divided by each other.
  const censusInsns=a1.r.insns;
  const sum=(...k)=>k.reduce((a,n)=>a+c[n],0);
  const invariants={
   classesSumToTotal:sum('readEspTotal','readEbpTotal','readOtherTotal','readIneligible')===c.readTotal,
   espWidthsSum:sum('readEspW8','readEspW16','readEspW32','readEspW64','readEspW128')===c.readEspTotal,
   ebpWidthsSum:sum('readEbpW8','readEbpW16','readEbpW32','readEbpW64','readEbpW128')===c.readEbpTotal,
   ebpBandsSum:sum('readEbpNear4k','readEbpNear64k','readEbpNear1m','readEbpFar')===c.readEbpTotal,
   otherWidthsFit:sum('readOtherW32','readOtherW64','readOtherW128')<=c.readOtherTotal,
   leaveNearFits:c.stackLeaveNear64k<=c.stackLeaveRead,
   censusInsnsCounted:censusInsns>0,
  };
  // arms 2-5: executed bytes at each knob mode, class census OFF
  await arm("w.set_stack_class_census(0);"
   +"if(w.get_stack_class_census()!==0) throw new Error('class census did not disarm');");
  const byteRows=[];
  for (const mode of [0,1,2,3]) {
   await arm("w.set_stack_raw_unsafe("+mode+");"
    +"if(w.get_stack_raw_unsafe()!=="+mode+") throw new Error('mode readback');");
   const w=await window10('байты, режим '+mode,
    "globalThis.preemption.getWasmExports().emit_bytes_reset();return true;",
    "const w=globalThis.preemption.getWasmExports();"
    +"return {bytes:w.emit_bytes_get(0),insns:w.emit_bytes_get(1)};");
   byteRows.push({mode,bytesPerSecond:Math.round(w.r.bytes/10),insnsPerSecond:Math.round(w.r.insns/10),
    bytesPerInsn:w.r.insns?+(w.r.bytes/w.r.insns).toFixed(2):null,valid:w.valid});
  }
  const base=byteRows[0];
  // See emittedBytes: the share is per RETIRED INSTRUCTION. Removing guards speeds the guest up,
  // so a per-second denominator folds the speed-up into the byte saving. On this very run that
  // turns the cross-check below from +1.3% (agrees) into -10.9% (refuses) while nothing about
  // the emitted code changed.
  const share=r=>base.bytesPerInsn?+(100*(1-r.bytesPerInsn/base.bytesPerInsn)).toFixed(2):null;
  const perSecond=r=>base.bytesPerSecond?+(100*(1-r.bytesPerSecond/base.bytesPerSecond)).toFixed(2):null;
  const byteShare=Object.fromEntries(byteRows.slice(1).map(r=>['mode'+r.mode,share(r)]));
  const byteSharePerSecond=Object.fromEntries(byteRows.slice(1).map(r=>['mode'+r.mode,perSecond(r)]));
  // the cross-check
  // Read counts predict the byte ratio: mode 1 and mode 2 elide the IDENTICAL per-read guard
  // sequence, over populations the class census counted separately.
  const covered1=sum('readEspW32','readEbpW32');
  const covered2=covered1+c.readOtherW32;
  const predicted=covered2?covered1/covered2:null;
  const measured=byteShare.mode2?byteShare.mode1/byteShare.mode2:null;
  const crossCheck={predictedRatio:predicted&&+predicted.toFixed(4),
   measuredRatio:measured&&+measured.toFixed(4),
   relativeError:predicted&&measured?+((measured-predicted)/predicted).toFixed(4):null};
  crossCheck.agrees=crossCheck.relativeError!==null&&Math.abs(crossCheck.relativeError)<=0.10;
  const t=c.readTotal||1;
  // The whole-guard-chain ablation is +10.06% frame (independently measured). The ceiling is
  // mode 1's MEASURED share of that chain's bytes, times that gain — deliberately NOT the
  // "1% of bytes = 0.53% FPS" rate, which is 10.06/18.9 restated and therefore cannot check
  // anything derived from it.
  const CHAIN=10.06;
  const chainBytes=byteShare.mode3??byteShare.mode2;
  const modeOneFraction=chainBytes?byteShare.mode1/chainBytes:null;
  // ── the LEVER's class is wider than the KNOB's ───────────────────────────────────────────
  // The knob branches inside gen_modrm_resolve_safe_read32 and so cannot touch PUSH/POP/CALL/
  // RET/LEAVE. A guard proving a window around ESP covers them all (B §3.2: "no check at all on
  // the covered accesses inside the unit"). To price them, derive the guard's byte cost PER
  // ELIDED READ from the arms that did run — and check that derivation against itself: modes 1
  // and 2 elide the same sequence over different populations, so both must give the same rate.
  const perInsn=n=>censusInsns?n/censusInsns:0;
  const b0=base.bytesPerInsn;
  const rateFrom=(arm,reads)=>{
   const saved=b0-byteRows[arm].bytesPerInsn, r=perInsn(reads);
   return r?saved/r:null;
  };
  const rate1=rateFrom(1,sum('readEspW32','readEbpW32'));
  const rate2=rateFrom(2,sum('readEspW32','readEbpW32')+c.readOtherW32);
  const rateCheck={fromMode1:rate1&&+rate1.toFixed(2),fromMode2:rate2&&+rate2.toFixed(2),
   relativeError:rate1&&rate2?+((rate2-rate1)/rate1).toFixed(4):null};
  rateCheck.agrees=rateCheck.relativeError!==null&&Math.abs(rateCheck.relativeError)<=0.10;
  // Reads only: the raw-memory ablation measured the same ratio with and without write guards,
  // so PUSH/CALL writes are counted and reported but never added to a ceiling.
  const extraReads=c.stackPopRead32+c.stackLeaveNear64k;
  const extraByteShare=rate1&&b0?+(100*perInsn(extraReads)*rate1/b0).toFixed(2):null;
  const wider=extraByteShare===null||!chainBytes?null:{
   guardBytesPerRead:rateCheck.fromMode1, rateCheck,
   popRead32:c.stackPopRead32, leaveReadInWindow:c.stackLeaveNear64k,
   pushWrite32:c.stackPushWrite32, note:'writes weigh ~0 by ablation; not in the ceiling',
   extraByteSharePct:extraByteShare,
   leverByteSharePct:+(byteShare.mode1+extraByteShare).toFixed(2),
   leverCeilingPct:+(10.06*(byteShare.mode1+extraByteShare)/chainBytes).toFixed(2),
   leverCeilingDiscounted:+(10.06*(byteShare.mode1+extraByteShare)/chainBytes/3).toFixed(2)};
  const espShare=c.readEspTotal/t, ebpInWindow=sum('readEbpNear4k','readEbpNear64k')/t;
  // Within the class, how much a SOUND guard reaches: ESP always, EBP only when in-window.
  const espOfClass=(c.readEspW32+c.readEbpW32)?c.readEspW32/(c.readEspW32+c.readEbpW32):0;
  const ebpInWindowOfEbp=c.readEbpTotal?sum('readEbpNear4k','readEbpNear64k')/c.readEbpTotal:0;
  const soundFraction=espOfClass+(1-espOfClass)*ebpInWindowOfEbp;
  const measuredCeiling=modeOneFraction===null?null:{
   knobSuperset:+(CHAIN*modeOneFraction).toFixed(2),
   espOnly:+(CHAIN*modeOneFraction*espOfClass).toFixed(2),
   espPlusEbpInWindow:+(CHAIN*modeOneFraction*soundFraction).toFixed(2),
   espPlusEbpInWindowDiscounted:+(CHAIN*modeOneFraction*soundFraction/3).toFixed(2),
   modeOneShareOfChain:+(modeOneFraction).toFixed(4)};
  const row={counters:c,censusInsns,invariants,byteRows,byteShare,byteSharePerSecond,crossCheck,
   measuredCeiling,wider,
   shares:{esp:+espShare.toFixed(4),ebp:+(c.readEbpTotal/t).toFixed(4),
    ebpInWindow64k:+ebpInWindow.toFixed(4),other:+(c.readOtherTotal/t).toFixed(4),
    ineligible:+(c.readIneligible/t).toFixed(4)},
   ceilingPct:{espOnly:+(espShare*CHAIN).toFixed(2),
    espOnlyDiscounted:+(espShare*CHAIN/3).toFixed(2),
    espPlusEbpInWindow:+((espShare+ebpInWindow)*CHAIN).toFixed(2),
    espPlusEbpInWindowDiscounted:+((espShare+ebpInWindow)*CHAIN/3).toFixed(2),
    knobSupersetEspPlusAllEbp:+((espShare+c.readEbpTotal/t)*CHAIN).toFixed(2)},
   valid:a1.valid&&byteRows.every(r=>r.valid)&&Object.values(invariants).every(Boolean)
    &&(wider===null||rateCheck.agrees)};
  await save('stack-class-census',row);
  note('reads '+c.readTotal+' → ESP '+(100*row.shares.esp).toFixed(1)+'% · EBP '
   +(100*row.shares.ebp).toFixed(1)+'% (в окне 64K '+(100*row.shares.ebpInWindow64k).toFixed(1)
   +'%) · прочие '+(100*row.shares.other).toFixed(1)+'% | байты: '+JSON.stringify(byteShare)
   +' | сверка '+(crossCheck.agrees?'СОШЛАСЬ':'РАЗОШЛАСЬ')+' ('+crossCheck.predictedRatio+' vs '
   +crossCheck.measuredRatio+') → измеренный потолок: ESP-only '+measuredCeiling?.espOnly
   +'%, ESP+EBP-в-окне '+measuredCeiling?.espPlusEbpInWindow+'% (после /3: '
   +measuredCeiling?.espPlusEbpInWindowDiscounted+'%) | ШИРЕ (с POP/RET/LEAVE): байт '
   +wider?.leverByteSharePct+'%, потолок '+wider?.leverCeilingPct+'% (после /3: '
   +wider?.leverCeilingDiscounted+'%), охранник '+wider?.guardBytesPerRead+' байт/чтение '
   +(rateCheck.agrees?'СОШЁЛСЯ':'РАЗОШЁЛСЯ')+(row.valid?'':' (ОТКЛОНЕНО)'));
  return row;
 } finally {
  await call('pause').catch(()=>{});
  await arm("w.set_stack_raw_unsafe(0); w.set_stack_class_census(0); w.set_dispatch_stats(0);")
   .catch(()=>{});
 }
}

/** Measurement 3 of the perf campaign: the io config arm, plus the three ride-alongs that a
 *  single NFSU boot owes.
 *
 *  ONE ARM PER PROCESS. `cacheMB` / `prefetchChunks` are read ONCE from `globalThis.__wgbIoTune`
 *  at `SabIoSource.create` (`sab-io-source.ts:170`), i.e. at bundle load — they are not runtime
 *  knobs like the JIT config, so an arm is a fresh load seeded by
 *  `?flags={"__wgbIoTune":{...}}`, never an in-boot toggle. Compare arms across runs.
 *
 *  The readback is not a formality. A flag that failed to apply produces a perfectly plausible
 *  arm, and the io worker deliberately echoes its EFFECTIVE tuning into the control words for
 *  exactly this reason — so the requested tune and the echoed one are compared here and a
 *  mismatch REFUSES rather than reports.
 *
 *  Ride-alongs, all read in the same boot because a boot costs minutes:
 *   1. the d3d9 counter fix — `report()` and the live snapshot must answer equally for every
 *      shared counter name (they disagreed by millions before the fix, and that claim has
 *      never been checked on a running worker);
 *   2. `arenaRunReconcile` — either the shortfall itemises by reason or `apiDrawUnaccounted`
 *      names a real leak; it can no longer be quiet and wrong;
 *   3. `bindGroupSetSameGroup` — a FALSIFIABLE prediction. If the arena replay really does
 *      bump-allocate a fresh offset per pair, sameGroup must be LARGE. Near zero refutes that
 *      model and the elision has to be re-examined. */
export async function ioConfig({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');

 // What this boot was actually seeded with, and what the io worker actually applied.
 const requested=await call('evalWorker',
   "return {tune:globalThis.__wgbIoTune??null};");
 const armed=await call('ioReport');
 if(!armed.armed)throw Error('ioReport not armed: '+(armed.reason??'unknown')
  +' — this bundle is not streamed, so measurement 3 has no subject on this boot');
 const effective=armed.ioWorker?.config??null;
 if(!effective)throw Error('ioReport carries no effective config; cannot verify the tune applied');
 const req=requested.tune??{};
 const mismatch=Object.entries(req)
  .filter(([k,v])=>typeof v==='number'&&effective[k]!==undefined&&effective[k]!==v)
  .map(([k,v])=>k+' requested '+v+' but io-worker applied '+effective[k]);
 if(mismatch.length)throw Error('io tune did not take: '+mismatch.join('; '));

 await save('io-config-arm',{requested:req,effective,lifetimeBefore:armed});
 note('Рука io: '+JSON.stringify(effective));

 // ── the window ───────────────────────────────────────────────────────────────────────────
 await call('resume');note('Прогрев io: 12 с');await sleep(12000);
 await call('ioMark');
 const sb=await call('evalWorker',scene);
 note('Окно io: 20 с');await sleep(20000);
 const io=await call('ioReport',{since:'mark'});
 const sa=await call('evalWorker',scene);
 await call('pause');

 // ── ride-along 1: one answer per counter name ────────────────────────────────────────────
 const live=await call('evalWorker',
   "return import('/src/worker/modules/d3d9/shared-state.ts').then(m=>{"
  +"const s=m.getD3D9PerfSnapshotWithDevices();return {backend:s.backend,api:s.api,wbuf:s.wbuf};});");
 const rep=await call('report');
 const repBackend=rep?.d3d9?.backend??{};
 const names=[...new Set([...Object.keys(live.backend??{}),...Object.keys(repBackend)])];
 const disagree=names.filter(n=>(live.backend?.[n]??0)!==(repBackend[n]??0))
  .map(n=>({name:n,live:live.backend?.[n]??0,report:repBackend[n]??0}));

 // ── ride-along 2: the draw ledger ────────────────────────────────────────────────────────
 const rec=await call('evalWorker',
   "return import('/src/worker/modules/d3d9/d3d9-perf.ts').then(m=>"
  +"import('/src/worker/modules/d3d9/shared-state.ts').then(s=>{"
  +"const snap=s.getD3D9PerfSnapshotWithDevices();"
  +"return {reconcile:m.reconcileD3D9ArenaRuns(snap.wbuf,snap.api,snap.backend),"
  +"unencoded:snap.indexedDrawUnencoded??null,dropped:snap.droppedDraws??null};}));");

 // ── ride-along 3: the falsifiable prediction ─────────────────────────────────────────────
 const b=live.backend??{};
 const skips=b.bindGroupSetSkips??0, sets=b.bindGroupSet??b.bindGroupSets??0, same=b.bindGroupSetSameGroup??0;
 const bindModel=same>0
  ? 'CONFIRMED: asked and refused by the moving offset ('+same+' same-group sets, '+skips+' skips)'
  : 'REFUTED or not exercised: sameGroup is '+same+' — the arena model predicts a LARGE value';

 const row={requested:req,effective,io,
  ride:{counterParity:{names:names.length,disagree},reconcile:rec,
   bind:{sets,skips,sameGroup:same,verdict:bindModel}},
  valid:valid(sb)&&valid(sa)&&sa.mover>sb.mover};
 await save('io-config',row);
 note('io: запросов '+io.guest?.requests+', ожидание '+io.guest?.waitMs+' мс (p50 '
  +io.guest?.p50Ms+' / p95 '+io.guest?.p95Ms+' / p99 '+io.guest?.p99Ms+') | счётчики: '
  +(disagree.length?'РАСХОДЯТСЯ в '+disagree.length+' именах':'сходятся во всех '+names.length)
  +' | draws: '+(rec.reconcile?.healthy?'healthy':'unaccounted='+rec.reconcile?.apiDrawUnaccounted)
  +' | bind: '+bindModel+(row.valid?'':' (ОТКЛОНЕНО)'));
 return row;
}

/** The three NFSU ride-alongs, split out of `ioConfig` because they are NFSU-specific and the
 *  io arm is not: project G's entire evidence is PAINKILLER (portfolio §"Project G" — 382 blocked
 *  reads, 48 MB cache against a ~296 MB working set, 328 random faults against 28 sequential).
 *  Measuring the io config on NFSU would be the `bindGroupSetSkips` mistake again: reading a
 *  counter on a title that does not exercise the mechanism.
 *
 *  A lifetime `ioReport` is taken here anyway, as an OBSERVATION rather than a measurement —
 *  how much this title streams at all is exactly what says whether it could ever have stood in. */
export async function nfsuRideAlongs({call,save,note,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');

 // 1 — one answer per counter name (owed since session 1; argued from code, never measured).
 const live=await call('evalWorker',
   "return import('/src/worker/modules/d3d9/shared-state.ts').then(m=>{"
  +"const s=m.getD3D9PerfSnapshotWithDevices();"
  +"return {backend:s.backend,api:s.api,unencoded:s.indexedDrawUnencoded??null};});")
  .catch(e=>({error:String(e),backend:{}}));
 const rep=await call('report').catch(e=>({error:String(e)}));
 const repBackend=rep?.d3d9?.backend??{};
 const names=[...new Set([...Object.keys(live.backend??{}),...Object.keys(repBackend)])];
 const disagree=names.filter(n=>(live.backend?.[n]??0)!==(repBackend[n]??0))
  .map(n=>({name:n,live:live.backend?.[n]??0,report:repBackend[n]??0}));

 // 2 — the draw ledger: itemised, or a named leak. It can no longer be quiet and wrong.
 //     `wbuf` is NOT on the perf snapshot — dbg-commands enriches it from the dispatcher
 //     (`dbg-commands.ts:2267`), and `report()` carries neither it nor the reconcile at all.
 //     So this reads the dispatcher the same way rather than trusting the snapshot to be whole.
 const rec=await call('evalWorker',
   "return import('/src/worker/modules/d3d9/d3d9-perf.ts').then(m=>"
  +"import('/src/worker/modules/d3d9/shared-state.ts').then(s=>{"
  +"const snap=s.getD3D9PerfSnapshotWithDevices();"
  +"const d=System.getInstance().process?.dispatcher;"
  +"const wbuf=d&&d.getWbufStats?d.getWbufStats():null;"
  +"return {wbuf,"
  +"reconcile:wbuf?m.reconcileD3D9ArenaRuns(wbuf,snap.api,snap.backend):null,"
  +"reconcileMissingBecause:wbuf?null:'dispatcher has no getWbufStats',"
  +"unencoded:snap.indexedDrawUnencoded??null,dropped:snap.droppedDraws??null};}));")
  .catch(e=>({error:String(e)}));

 // 3 — the falsifiable prediction. The arena model says sameGroup must be LARGE.
 const b=live.backend??{};
 const skips=b.bindGroupSetSkips??0, sets=b.bindGroupSets??0, same=b.bindGroupSetSameGroup??0;
 const verdict=sets===0?'NOT EXERCISED (0 sets)'
  :same>sets*0.5?'CONFIRMED: '+same+' of '+sets+' sets repeated the group and were refused by the moving offset'
  :same>0?'PARTIAL: '+same+' of '+sets+' — smaller than the arena model predicts, look again'
  :'REFUTED: sameGroup is 0 against '+sets+' sets — the arena model does not hold';

 // Observation only: does this title stream enough to have hosted measurement 3 at all?
 const ioLifetime=await call('ioReport').catch(e=>({armed:false,reason:String(e)}));
 // report() carries no wbuf and no arenaRunReconcile (grep build-report.ts) — worth recording,
 // because CLAUDE.md sends every agent to report() first and the reconcile is invisible there.
 const reportCarriesReconcile=rep?.d3d9?.arenaRunReconcile!==undefined;

 const row={counterParity:{names:names.length,disagree,agrees:disagree.length===0,
   liveError:live.error??null,reportError:rep?.error??null,reportCarriesReconcile},
  reconcile:rec,bind:{sets,skips,sameGroup:same,verdict},
  ioObservation:{armed:ioLifetime.armed,
   requests:ioLifetime.guest?.requests??null,waitMs:ioLifetime.guest?.waitMs??null,
   config:ioLifetime.ioWorker?.config??null,
   note:'OBSERVATION, not measurement 3: project G is a Painkiller signature'},
  valid:valid(await call('evalWorker',scene))};
 await save('nfsu-ride-alongs',row);
 note('счётчики: '+(row.counterParity.agrees?'сходятся во всех '+names.length:'РАСХОДЯТСЯ в '+disagree.length)
  +' | draws: '+(rec.reconcile?.healthy?'healthy':'unaccounted='+rec.reconcile?.apiDrawUnaccounted)
  +' | bind: '+verdict+' | io (наблюдение): '+(ioLifetime.armed?ioLifetime.guest?.requests+' запросов, '+ioLifetime.guest?.waitMs+' мс':'не стримится'));
 return row;
}

/** The four numbers that discriminate the three explanations of `apiDrawUnaccounted`, plus the
 *  control that separates two of them without any code reading at all.
 *
 *  WHY THE CONTROL MATTERS MORE THAN THE NUMBERS. `apiDrawIndexed` is minted at the API call and
 *  `drawIndexedCalls` at encode, so a snapshot taken at an arbitrary instant counts every draw
 *  already recorded into a frame that has not been submitted yet as "unaccounted", with an empty
 *  ledger and nothing lost. A single reading cannot tell that from a leak — which is how "+100"
 *  and "+4" were once divided by their windows and reported as a consistent rate. They are two
 *  TAIL SIZES, not two event counts.
 *
 *  So: take the snapshot TWICE with presents in between. A work-in-flight residual moves with the
 *  recording frame; a genuine leak accumulates monotonically. Three readings make the difference
 *  between "wanders around a small number" and "grows" visible without arithmetic.
 *
 *  Decision tree (from the agent that built the counters):
 *    threw: N present                          -> the exception path, closed
 *    submitRefused:<site>: N present           -> the submit-refusal path, closed, site named
 *    ledger empty AND recorded-calls == unaccounted -> nothing lost; the snapshot caught a frame
 *                                                     mid-record
 *    ledger empty AND api > recorded           -> an eighth path, between the api counter and
 *                                                 recordDrawIndexed: half the search space gone
 */
export async function drawLedger({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');

 const read=()=>call('evalWorker',
   "return import('/src/worker/modules/d3d9/d3d9-perf.ts').then(m=>"
  +"import('/src/worker/modules/d3d9/shared-state.ts').then(s=>{"
  +"const snap=s.getD3D9PerfSnapshotWithDevices();"
  +"const d=System.getInstance().process?.dispatcher;"
  +"const wbuf=d&&d.getWbufStats?d.getWbufStats():null;"
  +"const b=snap.backend||{};"
  +"return {t:performance.now(),serial:System.getInstance().services.render.getPresentSerial(),"
  +"api:snap.api&&snap.api.drawIndexedPrimitive,"
  +"backendCalls:b.drawIndexedCalls,recorded:b.drawIndexedRecorded,"
  +"throws:b.indexedDrawThrows,"
  +"skips:b.bindGroupSetSkips,sameGroup:b.bindGroupSetSameGroup,sets:b.bindGroupSets,"
  +"unencoded:snap.indexedDrawUnencoded||null,dropped:snap.droppedDraws||null,"
  +"arenaInvariantFailures:b.arenaRunInvariantFailures??null,"
  +"reconcile:wbuf?m.reconcileD3D9ArenaRuns(wbuf,snap.api,snap.backend):null};}));");

 await call('resume');note('Прогрев: 12 с');await sleep(12000);
 const samples=[];
 for(let i=0;i<3;i++){
  samples.push(await read());
  if(i<2){note('Снимок '+(i+1)+'/3 снят; 5 с до следующего');await sleep(5000);}
 }
 const after=await call('evalWorker',scene);
 await call('pause');

 const rows=samples.map(s=>({
  serial:s.serial,
  api:s.api,backendCalls:s.backendCalls,recorded:s.recorded,
  // the reconcile's own residual
  unaccounted:s.reconcile?s.reconcile.apiDrawUnaccounted:null,
  // the two halves the new term splits it into
  lostBeforeCommand:(s.api??0)-(s.recorded??0),
  recordedNotConsumed:(s.recorded??0)-(s.backendCalls??0),
  throws:s.throws,unencoded:s.unencoded,dropped:s.dropped,
 }));
 const resid=rows.map(r=>r.unaccounted);
 const monotonic=resid.every((v,i)=>i===0||v>=resid[i-1]);
 const grew=resid[2]-resid[0];
 const ledgerNamed=samples.some(s=>s.unencoded&&Object.keys(s.unencoded).length>0);
 const verdict=ledgerNamed
  ? 'LEDGER NAMES IT: '+JSON.stringify(samples[2].unencoded)
  : (rows.every(r=>r.lostBeforeCommand<=0)
     ? 'WORK IN FLIGHT: api never exceeds recorded, so nothing was lost before a command existed'
     : (monotonic&&grew>0
        ? 'EIGHTH PATH: the residual is monotonic and grew by '+grew+' across '
          +(rows[2].serial-rows[0].serial)+' presents, and api exceeds recorded'
        : 'WANDERS: residual '+resid.join(' -> ')+' is not monotonic — consistent with a moving tail, not a leak'));

 const row={samples:rows,residual:resid,monotonic,grewBy:grew,
  presents:rows[2].serial-rows[0].serial,
  bind:{sets:samples[2].sets,skips:samples[2].skips,sameGroup:samples[2].sameGroup},
  arenaInvariantFailures:samples[2].arenaInvariantFailures,
  verdict,valid:valid(after)};
 await save('draw-ledger',row);
 note('остаток '+resid.join(' → ')+' за '+row.presents+' present | '+verdict
  +(row.valid?'':' (ОТКЛОНЕНО)'));
 return row;
}

/** Step 1 of the render-worker experiment: how often would the guest thread have to FENCE?
 *
 *  THE HYPOTHESIS BEING TESTED. 15-22% of the worker thread is work that runs on the guest's
 *  thread and owes the guest no synchronous answer (the ring drain + the executor's frame walk).
 *  Moving it to its own worker over shared memory stops that time summing with the guest's — but
 *  only if the guest rarely asks a question whose answer depends on the queued work. Every such
 *  call is a cross-thread round trip, and at a high enough rate they eat the whole win.
 *
 *  So this is the gate, and it is deliberately measured BEFORE anything is built: a coarse
 *  per-frame rate of calls by class. The classification is by name suffix and is PRINTED with the
 *  result, because a classifier nobody can audit is how a plausible number gets attributed to the
 *  wrong cause — that failure happened six times in this codebase in one session.
 *
 *  Three classes, and the distinction that matters is the third:
 *    fireAndForget      returns S_OK with nothing the guest reads back  -> never a fence
 *    answerableLocally  a Get* we serve from our own shadow, or a Create* whose handle we can
 *                       mint eagerly                                    -> never a fence
 *    needsQueuedWork    the answer depends on work already queued: Lock/LockRect on a resource
 *                       in flight, readbacks, query GetData             -> A FENCE
 *
 *  D3D9 already carries the contract that makes the design possible: D3DLOCK_DISCARD and
 *  D3DLOCK_NOOVERWRITE exist precisely so a driver can keep rendering while the app writes, and
 *  real drivers rely on it. So a high Lock rate is NOT fatal on its own — it only decides whether
 *  the next (more expensive) step is a per-flag breakdown. That refinement is worth building only
 *  if this coarse number lands anywhere near the draw rate.
 */
export async function fenceCensus({call,save,note,sleep,scene}){
 const valid=s=>s.raceState===4&&s.mode===3&&s.track===1003&&s.traffic===0&&s.players===1;
 const initial=await call('evalWorker',scene);
 if(!valid(initial)||!initial.paused)throw Error('Нужна готовая сцена на паузе');

 const snap=async()=>{
  const c=await call('apiCensus');
  const s=await call('evalWorker',scene);
  const rows={};
  for(const r of (c?.calls??c??[])){ if(r&&r.api) rows[r.api]=r.count; }
  return {rows,serial:s.serial,t:s.time};
 };

 await call('resume');note('Прогрев: 10 с');await sleep(10000);
 const a=await snap();
 note('Окно переписи вызовов: 20 с');await sleep(20000);
 const b=await snap();
 await call('pause');
 const frames=b.serial-a.serial;
 if(frames<50)throw Error('too few presents in the window: '+frames);

 // ── the classifier, printed with the result ─────────────────────────────────────────────
 const FENCE=[/_Lock(Rect|Box)?$/,/_GetRenderTargetData$/,/_GetFrontBufferData$/,/_GetData$/,
              /_GetDC$/,/_TestCooperativeLevel$/,/_Present$/];
 const LOCAL=[/_Get[A-Z]/,/_Create[A-Z]/,/_Release$/,/_AddRef$/,/_QueryInterface$/];
 const cls=n=>FENCE.some(r=>r.test(n))?'needsQueuedWork'
            :LOCAL.some(r=>r.test(n))?'answerableLocally':'fireAndForget';

 const delta={},byClass={fireAndForget:0,answerableLocally:0,needsQueuedWork:0};
 const fenceRows=[];
 for(const [api,n] of Object.entries(b.rows)){
  const d=n-(a.rows[api]??0);
  if(d<=0)continue;
  delta[api]=d;
  const k=cls(api);
  byClass[k]+=d;
  if(k==='needsQueuedWork')fenceRows.push([api,d,+(d/frames).toFixed(2)]);
 }
 fenceRows.sort((x,y)=>y[1]-x[1]);
 const draws=Object.entries(delta).filter(([n])=>/_Draw/.test(n)).reduce((s,[,n])=>s+n,0);
 const total=byClass.fireAndForget+byClass.answerableLocally+byClass.needsQueuedWork;
 const perFrame=n=>+(n/frames).toFixed(2);

 const row={frames,draws,drawsPerFrame:perFrame(draws),total,
  byClass,perFrame:{fireAndForget:perFrame(byClass.fireAndForget),
   answerableLocally:perFrame(byClass.answerableLocally),
   needsQueuedWork:perFrame(byClass.needsQueuedWork)},
  fencesPerDraw:draws?+(byClass.needsQueuedWork/draws).toFixed(4):null,
  fenceRows:fenceRows.slice(0,15),
  classifier:{fence:FENCE.map(String),local:LOCAL.map(String)},
  // Ring-carried setters may not increment `count` (the row carries `wbufCount` separately), so
  // fireAndForget here is a LOWER bound. The decisive figure is absolute — fences per frame — and
  // a call that returns a value cannot be ring-buffered at all, so that half is unaffected.
  caveat:'fireAndForget may be understated: ring-carried calls count in wbufCount, not count',
  wbufCounts:Object.fromEntries((await call('apiCensus'))?.calls
   ?.filter(r=>r.wbufCount)?.slice(0,12)?.map(r=>[r.api,r.wbufCount])??[]),
  topCalls:Object.entries(delta).sort((x,y)=>y[1]-x[1]).slice(0,12)
   .map(([n,c])=>[n,c,perFrame(c),cls(n)]),
  valid:valid(await call('evalWorker',scene))};
 await save('fence-census',row);
 note('кадров '+frames+', draw/кадр '+row.drawsPerFrame
  +' | фенсов/кадр '+row.perFrame.needsQueuedWork
  +' ('+row.fencesPerDraw+' на draw) | без ответа '+row.perFrame.fireAndForget
  +'/кадр, локально '+row.perFrame.answerableLocally+'/кадр'
  +' | топ фенсов: '+fenceRows.slice(0,4).map(r=>r[0].replace(/^d3d9:IDirect3DDevice9_/,'')+' '+r[2]).join(', ')
  +(row.valid?'':' (ОТКЛОНЕНО)'));
 return row;
}
