// Causal offline AOT transform probe using the existing fixed-work v86 laboratory.
import {V86} from '../../vendor/v86/build/libv86.mjs';
import {SHIPPING_JIT} from '../jit-config/shipping.mjs';
import {createX87Workload} from './x87-workload.mjs';
import {aotIdentity,publishUnit} from '../aot-oracle/lib/engine-unit.mjs';
const node=typeof process!=='undefined'&&!!process.versions?.node;
const fs=node?(await import('node:fs')).default:null,path=node?(await import('node:path')).default:null;
const cryptoNode=node?await import('node:crypto'):null;
const hash=async b=>node?cryptoNode.createHash('sha256').update(b).digest('hex'):
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(b).buffer)),x=>x.toString(16).padStart(2,'0')).join('');
const wasm=node?new URL('../../public/v86.wasm',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'):'/v86.wasm';
const engine=node?fs.readFileSync(wasm):new Uint8Array(await(await fetch(wasm)).arrayBuffer());
const engineSha256=await hash(engine),engineModule=await WebAssembly.compile(engine);
const cfg=node?null:await(await fetch('/apps/source-pair-lab/config.json')).json();
const mutation=node&&process.argv.includes('--mutation-skip');
const transform=mutation?bytes=>import('../aot/lib/inline-rotate.mjs').then(({rewriteHelperCalls})=>
    rewriteHelperCalls(bytes,{name:'instr_0FC6',type:{params:[127,127,127],results:[]},locals:1,emit:()=>[26,26,26]})):
    node?(await import('../aot/lib/shufps-specialize.mjs')).specializeShufpsCalls:async bytes=>{
    const response=await fetch(new URL('/transform-shufps',cfg.collector),{method:'POST',body:new Uint8Array(bytes)});
    const r=await response.json();if(!response.ok)throw Error(r.error);
    if(r.engineSha256!==engineSha256||r.inputSha256!==await hash(bytes))throw Error('Transform identity mismatch');
    const output=Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0));
    if(r.outputSha256!==await hash(output))throw Error('Transform output mismatch');return {...r,bytes:output};
};
const api=createX87Workload(V86,{wasm,shipping:SHIPPING_JIT,engineModule});
const broadcast=node?process.argv.includes('--broadcast'):new URLSearchParams(location.search).get('broadcast')==='1';
const kind=broadcast?'flags-sse-broadcast':'flags-sse-shufps';
const im=api.image(kind),b=await api.boot(im,{locals:1}),variants=[];
const identity=node?process.argv.includes('--identity'):new URLSearchParams(location.search).get('identity')==='1';
const report={environment:node?process.version:navigator.userAgent,engineSha256,kind,identity,mutation,status:'running',scope:'synthetic causal probe, not game acceptance',warmup:[],samples:[],modules:[]};
if(node)report.hostCompiler={v8:process.versions.v8,execArgv:process.execArgv,
    nodeOptions:process.env.NODE_OPTIONS??'',executable:process.execPath};
try {
    for(let i=0;i<3;i++)report.warmup.push(api.measure(b,im,1000000,{warming:true}));
    const latest=new Map(globalThis.__wasmDump.out.map(r=>[r.table_index,r]));
    for(const [idx,r] of latest){
        if((b.w.jit_aot_page_table_index(r.start&~4095)>>>0)!==idx)continue;
        const tr=await transform(r.bytes,engine);if(!tr.sites)continue;
        // A pending engine compilation may publish while the offline transform
        // yields. Recheck ownership before binding bytes to publication metadata.
        if((b.w.jit_aot_page_table_index(r.start&~4095)>>>0)!==idx)continue;
        const slot=idx+1024,original=b.c.wm.wasm_table.get(slot);
        const candidateBytes=identity?r.bytes:tr.bytes;
        const pages=[];
        for(let i=0;i<b.w.jit_aot_module_page_count(idx);i++){
            const address=b.w.jit_aot_module_page_at(idx,i)>>>0;
            if(address===0xffffffff)throw Error('Invalid module page');
            const entries=[];
            for(let j=0;j<b.w.jit_aot_page_entry_count(address);j++){
                const packed=b.w.jit_aot_page_entry_at(address,j)>>>0;
                if(packed===0xffffffff)throw Error('Invalid entry');entries.push([packed>>>16,packed&65535]);
            }
            pages.push({physPage:address>>>12,stateFlags:b.w.jit_aot_page_state_flags(address)>>>0,entries,
                sha:await hash(b.c.mem8.subarray(address,address+4096))});
        }
        if(!pages.length||(b.w.jit_aot_page_table_index(r.start&~4095)>>>0)!==idx||b.c.wm.wasm_table.get(slot)!==original)throw Error('Publication changed during metadata hashing');
        variants.push({idx,slot,original,current:original,page:r.start&~4095,
            originalBytes:r.bytes,
            unit:{entryPage:r.start>>>12,tableIndex:idx,pages,bytes:candidateBytes}});
        report.modules.push({idx,sites:identity?0:tr.sites,before:r.bytes.length,after:candidateBytes.length,input:await hash(r.bytes),output:await hash(candidateBytes)});
    }
    if(!variants.length)throw Error('No transformed live module');
    report.identityEnvelope=aotIdentity(b.c,engineSha256);
    const saveAt=node?process.argv.indexOf('--save'):-1;
    if(saveAt>=0){
        const root=process.argv[saveAt+1];if(!root||fs.existsSync(root))throw Error('Save directory must be new');
        for(const arm of ['original','candidate']){
            const dir=path.join(root,arm);fs.mkdirSync(dir,{recursive:true});
            const units=variants.map(v=>{
                const {bytes,...unit}=v.unit,content=arm==='original'?v.originalBytes:bytes,file=`${v.idx}.wasm`;
                fs.writeFileSync(path.join(dir,file),content);return {...unit,file,bytes:content.length};
            });
            fs.writeFileSync(path.join(dir,'index.json'),JSON.stringify({jit_identity:report.identityEnvelope,
                engine_sha256:engineSha256,units},null,2));
        }
        report.saved=root;
    }
    b.w.jit_clear_cache_js(); // diagnostic cache reset; no guest memory writes
    report.replay=[];
    for(const v of variants){
        const hashes=new Map();
        for(const p of v.unit.pages)hashes.set(p.physPage,await hash(b.c.mem8.subarray(p.physPage*4096,p.physPage*4096+4096)));
        const published=publishUnit(b.c,v.unit,report.identityEnvelope,{countExecutions:false,
            pageSha:page=>hashes.get(page)});
        if(!published.registered)throw Error('AOT replay refused: '+published.why);
        v.candidate=published.fn;v.current=published.fn;
        report.replay.push({idx:published.idx,pages:published.pages,registered:published.registered});
    }
    const select=arm=>{for(const v of variants){
        if(b.c.wm.wasm_table.get(v.slot)!==v.current||(b.w.jit_aot_page_table_index(v.page)>>>0)!==v.idx)throw Error('Module invalidated');
        v.current=arm==='A'?v.original:v.candidate;b.c.wm.wasm_table.set(v.slot,v.current);
    }};
    select('C');for(let i=0;i<3;i++)report.warmup.push(api.measure(b,im,1000000,{warming:true}));
    for(const arm of ['A','C','C','A','C','A','A','C']){
        select(arm);const batches=[];
        for(let batch=0;batch<(node?1:4);batch++)batches.push(api.measure(b,im,2000000));
        select(arm);report.samples.push({arm,ms:batches.reduce((n,s)=>n+s.ms,0),
            retired:batches.reduce((n,s)=>n+s.retired,0),entries:batches.reduce((n,s)=>n+s.entries,0),batches});
    }
    const median=xs=>{xs.sort((a,b)=>a-b);return(xs[1]+xs[2])/2;};
    report.medians=Object.fromEntries(['A','C'].map(a=>[a,median(report.samples.filter(s=>s.arm===a).map(s=>s.ms))]));
    report.speedup=report.medians.A/report.medians.C;report.status='ok';
}catch(error){report.status='error';report.error=String(error.stack||error);if(node)process.exitCode=1;}
finally{b.em.destroy();if(node)console.log(JSON.stringify(report,null,2));else postMessage(report);}
