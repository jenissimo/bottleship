// Static evidence, not a dynamic cost model or a rewrite-safety proof.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseModule,walkBody} from '../aot/lib/wdis.mjs';
import {moduleStats} from '../aot/module-stats.mjs';

export function findCr0Tests(ins,imports){
 const sites=[];
 for(let i=0;i+8<ins.length;i++){
  const a=ins.slice(i,i+9);
  if(a.map(x=>x.op).join(',')!=='65,45,65,113,4,65,16,12,11')continue;
  if(a[2].imm!==12||imports[a[6].imm]!=='task_switch_test_jit')continue;
  const d=a[0].depth;
  if(!a.slice(0,5).every(x=>x.depth===d)||!a.slice(5,8).every(x=>x.depth===d+1)||a[8].depth!==d)continue;
  // The fault arm must exit an enclosing scope rather than fall through.
  if(a[7].imm<1||a[7].imm>d)continue;
  sites.push({wasmOffset:a[0].offset,endOffset:a[8].offset+1,
   testedAddress:((a[0].imm>>>0)+(a[1].imm.offset>>>0))>>>0,
   mask:12,faultEipPageOffset:a[5].imm,scopeDepth:d,exitDepth:a[7].imm});
 }
 return sites;
}

export function findReadTranslations(ins,imports){
 const sites=[];
 const widths={safe_read8_slow_jit:1,safe_read16_slow_jit:2,safe_read32s_slow_jit:4,safe_read64s_slow_jit:8};
 for(let i=0;i+14<ins.length;i++){
  const a=ins.slice(i,i+11);
  if(a.map(x=>x.op).join(',')!=='32,65,118,65,116,40,34,65,113,65,70')continue;
  if(a[1].imm!==12||a[3].imm!==2||a[9].imm!==1)continue;
  let j=i+11,bytes=1;
  if(ins[j]?.op===32){
   const cross=ins.slice(j,j+6);
   if(cross.map(x=>x.op).join(',')!=='32,65,113,65,76,113'||cross[0].imm!==a[0].imm||cross[1].imm!==4095)continue;
   bytes=4096-cross[3].imm;if(![2,4,8].includes(bytes))continue;j+=6;
  }
  const tail=ins.slice(j,j+4);
  if(tail.map(x=>x.op).join(',')!=='13,32,65,16'||tail[0].imm!==0||tail[1].imm!==a[0].imm)continue;
  const helper=imports[tail[3].imm];if(widths[helper]!==bytes)continue;
  if(!ins.slice(i,j+4).every(x=>x.depth===a[0].depth))continue;
  const addr=a[0].imm;
  // Evidence for review only: a recycled local index is not an address identity.
  let definition=null;
  for(let k=i-1;k>=Math.max(0,i-16);k--){
   const x=ins[k];if([0x03,0x04,0x05,0x0b,0x0c,0x0d,0x0e,0x10,0x11].includes(x.op))break;
   if([0x21,0x22].includes(x.op)&&x.imm===addr){definition=ins.slice(Math.max(0,k-4),k+1).map(({offset,op,imm})=>({offset,op,imm}));break;}
  }
  let addressForm={kind:'unknown'};
  const suffix=definition?.slice(-4);
  if(suffix?.map(x=>x.op).join(',')==='32,65,106,33')addressForm={kind:'local-plus-constant',baseLocal:suffix[0].imm,displacement:suffix[1].imm};
  sites.push({wasmOffset:a[0].offset,helperOffset:tail[3].offset,addressLocal:addr,entryLocal:a[6].imm,addressForm,
   tlbBase:a[5].imm.offset,permissionMask:a[7].imm,bytes,faultEipPageOffset:tail[2].imm,helper,addressDefinitionContext:definition});
 }
 return sites;
}

export function analyze(bytes,file=''){
 // Validate independently before trusting our deliberately limited decoder.
 const native=new WebAssembly.Module(bytes),m=parseModule(bytes);
 if(m.code?.count!==1||m.functions.length!==1)throw Error('Expected a single defined JIT function; multi-function modules are unsupported');
 const stats=moduleStats(bytes,file); // Rejects unknown opcodes and unbalanced bodies.
 const ins=[...walkBody(bytes,m.code.instrStart,m.code.instrEnd)];
 const imports=m.imports.filter(x=>x.kind===0).map(x=>x.name);
 const cr0=findCr0Tests(ins,imports);
 const translations=findReadTranslations(ins,imports);
 const pairs=reviewAffinePairs(ins,translations,imports);
 const directPairs=findDirectReadPairs(ins,translations);
 const slowMemory=ins.filter(x=>x.op===16&&/^safe_(read|write).*_slow_jit$/.test(imports[x.imm]??''))
  .map(x=>({wasmOffset:x.offset,helper:imports[x.imm]}));
 const helperCount=ins.filter(x=>x.op===16&&imports[x.imm]==='task_switch_test_jit').length;
 const addresses=[...new Set(cr0.map(x=>x.testedAddress))];
 return {schema:1,file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
  exports:WebAssembly.Module.exports(native),ops:stats.ops,groups:stats.groups,
  cr0:{recognized:cr0.length,helperSites:helperCount,unrecognizedHelperSites:helperCount-cr0.length,addresses,sites:cr0},
  memory:{slowFallbackSites:slowMemory.length,sites:slowMemory,recognizedReadTranslations:translations.length,readTranslations:translations,affinePairReview:pairs,directReadPairs:directPairs},
  limitations:['Counts are static, not executions or time shares.',
   'CR0 identification requires the exact guard plus fault-helper pattern; unmatched sites remain explicit.',
   'Repeated guards are not proven redundant: guest boundaries, dominance and CR0 writers are not reconstructed.',
   'Recognized read translations require the full page-index/load/permission/range/branch/fallback pattern; other shapes remain unsupported.',
   'Memory sites and address-definition contexts do not prove dynamic misses, equal addresses or redundant translations.',
   'No guest-address or trace join is inferred from a recyclable table slot.',
   'CPU-state versus guest-memory counts from module-stats are deliberately omitted: their ABI heuristic does not apply here.']};
}

export function findDirectReadPairs(ins,sites){
 const indices=new Map(ins.map((x,i)=>[x.offset,i])),out=[];
 for(let n=0;n+1<sites.length;n++){
  const a=sites[n],b=sites[n+1];
  if(a.bytes!==4||b.bytes!==4||a.addressForm.kind!=='local-plus-constant'||b.addressForm.kind!=='local-plus-constant')continue;
  if(a.addressForm.baseLocal!==b.addressForm.baseLocal||a.permissionMask!==b.permissionMask||a.tlbBase!==b.tlbBase)continue;
  if([a.addressLocal,a.entryLocal,b.addressLocal,b.entryLocal].includes(a.addressForm.baseLocal))continue;
  const begin=indices.get(a.helperOffset),end=indices.get(b.wasmOffset);
  const t=ins.slice(begin+1,end);
  // Full first-read fault tail, fast load, destination assignment, second
  // address expression, second scratch initialization, second translation block.
  if(t.map(x=>x.op).join(',')!=='34,65,113,13,11,32,65,113,32,115,40,33,32,65,106,33,65,33,2')continue;
  if(t[0].imm!==a.entryLocal||t[1].imm!==1||t[3].imm<1||t[5].imm!==a.entryLocal||t[6].imm!==-4096||t[8].imm!==a.addressLocal||t[10].imm.offset!==0)continue;
  if(t[11].imm===a.addressForm.baseLocal||t[12].imm!==a.addressForm.baseLocal||t[13].imm!==b.addressForm.displacement||t[15].imm!==b.addressLocal||t[16].imm!==0||t[17].imm!==b.entryLocal)continue;
  const depth=ins[begin].depth;
  if(!t.slice(0,4).every(x=>x.depth===depth)||!t.slice(4).every(x=>x.depth===depth-1)||ins[end].depth!==depth)continue;
  const delta=b.addressForm.displacement-a.addressForm.displacement;
  const lower=Math.max(0,-delta),upper=4096-Math.max(4,delta+4);
  if(lower>upper)continue;
  out.push({first:a.wasmOffset,second:b.wasmOffset,baseLocal:a.addressForm.baseLocal,destinationLocal:t[11].imm,delta,lower,upper,
   fastTail:'exact direct read then unchanged-base address computation',
   pending:'Identify guest instructions/basic-block bounds and preserve all slow-path behavior before rewriting'});
 }
 return out;
}

export function reviewAffinePairs(ins,sites,imports){
 const previous=new Map(),pairs=[];
 const indices=new Map(ins.map((x,i)=>[x.offset,i]));
 for(const s of sites){
  if(s.addressForm.kind!=='local-plus-constant')continue;
  const base=s.addressForm.baseLocal,p=previous.get(base);previous.set(base,s);if(!p)continue;
  const begin=indices.get(p.wasmOffset),end=indices.get(s.wasmOffset);
  if(begin===undefined||end===undefined||end<=begin)throw Error('Invalid site offsets');
  const between=ins.slice(begin,end);
  const writes=between.filter(x=>[0x21,0x22].includes(x.op)&&x.imm===base).map(x=>x.offset);
  const calls=between.filter(x=>[0x10,0x11,0x12,0x13].includes(x.op)).map(x=>({offset:x.offset,name:x.op===0x10?imports[x.imm]??'defined-function':'indirect-or-tail-call'}));
  const control=between.filter(x=>[0x02,0x03,0x04,0x05,0x0b,0x0c,0x0d,0x0e,0x0f].includes(x.op)).length;
  const stores=between.filter(x=>x.op>=0x36&&x.op<=0x3e).length;
  const lo=Math.min(p.addressForm.displacement,s.addressForm.displacement);
  const hi=Math.max(p.addressForm.displacement+p.bytes,s.addressForm.displacement+s.bytes);
  pairs.push({first:p.wasmOffset,second:s.wasmOffset,baseLocal:base,baseWrites:writes,
   displacements:[p.addressForm.displacement,s.addressForm.displacement],rangeBytes:hi-lo,
   samePermission:p.permissionMask===s.permissionMask&&p.tlbBase===s.tlbBase,
   controlOperations:control,storeOperations:stores,calls,
   status:writes.length?'rejected-base-redefined':'requires-control-flow-and-effects-proof'});
 }
 return pairs;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const files=process.argv.slice(2);if(!files.length)throw Error('Usage: node analyze-jit-wasm.mjs <captured.wasm> ...');
 console.log(JSON.stringify(files.map(f=>analyze(fs.readFileSync(f),f)),null,2));
}
