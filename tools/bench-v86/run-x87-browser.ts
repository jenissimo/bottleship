// Own Chrome profile/server; no game tab or production artifact is touched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dir,'../..');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
config.affinityRequest=process.env.BS_BENCH_AFFINITY||null;
const mulpd=process.argv.includes('--mulpd');
const combinedSse=process.argv.includes('--combined-sse');
const pairedLive=process.argv.includes('--paired-live');
const mulpdContract=process.argv.includes('--mulpd-contract');
const inlineMove=combinedSse||mulpd||process.argv.includes('--inline-move');
const flagsMode=inlineMove||process.argv.includes('--flags');
config.workerPerArm=process.argv.includes('--worker');
config.settleMs=process.argv.includes('--settle')?500:0;
const traceDiagnostic=process.argv.includes('--diagnostic-integer-trace');
const cpuDiagnostic=process.argv.includes('--diagnostic-integer-cpu');
config.diagnostic=traceDiagnostic||cpuDiagnostic;
if(config.diagnostic&&!config.workerPerArm)throw Error('diagnostic trace requires --worker');
if(config.workerPerArm&&!flagsMode)throw Error('--worker requires a flag workload');
if(config.mutation)throw Error('cannot benchmark mutation');
config.order=['baseline','baseline','baseline','baseline',
    'baseline','candidate','candidate','baseline','baseline','candidate',
    'candidate','baseline','baseline','candidate','candidate','baseline'];
config.protocol='kernel-major paired order; max per-arm spread 10%; control median <=3%; no round dropping';
config.engineLifecycle='one retained compiled Module per arm, fresh Instance/memory per emulator';
if(config.workerPerArm)config.engineLifecycle='retained Module per arm; fresh Worker+Instance per kernel/arm; Worker terminated after result';
if(pairedLive&&(!flagsMode||config.workerPerArm||mulpdContract))throw Error('--paired-live requires a flag benchmark without --worker');
const driver=pairedLive?'flag-paired-live-browser.mjs':mulpdContract?'mulpd-contract-browser.mjs':config.workerPerArm?'flag-worker-browser.mjs':flagsMode?'flag-browser.mjs':'x87-browser.mjs';
if(flagsMode){
    config.arms={A:{...config.arms.baseline,flag:0},B:{...config.arms.baseline,flag:1},C:{...config.arms.candidate,flag:1}};
    config.pairs=['AA','AA','BB','BB','CC','CC','AC','CA','BC','CB','AC','CA','BC','CB'];
    if(inlineMove){
        delete config.arms.B;config.arms.C.flag=0;config.arms.C.inlineMove=true;
        if(mulpd)config.arms.A.inlineMove=true;
        if(mulpd&&['simd','scalar-order'].includes(config.mulpdMode))config.arms.C.inlineMulpd=true;
        if(combinedSse)config.arms.C.inlineMulpd=true;
        config.pairs=['AA','AA','CC','CC','AC','CA','AC','CA'];
    }
    config.order=config.pairs.join('').split('');
    config.kinds=inlineMove||process.argv.includes('--sse')?['flags-integer','flags-sse-reg','flags-sse-mem']:['flags-integer','flags-mixed','flags-fp'];
    config.iterations=5000000;config.rounds=7;
    if(process.argv.includes('--long-control'))config.iterationsByKind={'flags-integer':30000000};
    config.gate={maxSelfPairPercent:3,maxArmSpreadPercent:10};
    config.protocol='kernel-major fresh instances; AA/BB/CC noise floors; balanced AC/BC pairs; no dropping';
    if(pairedLive){
        config.engineLifecycle='one Worker; both warmed engines retained per kernel; per-engine telemetry restored before measure';
        config.protocol='same AA/CC/AC/CA pairs, interleave sides within each sample round; 7 rounds; no dropping; unchanged 3% self / 10% spread';
    }
}
config.hashes=Object.fromEntries(['x87-workload.mjs',driver,...(config.workerPerArm?['flag-browser-kernel.mjs','flag-browser-worker.mjs']:[])].map(n=>[n,createHash('sha256').update(fs.readFileSync(path.join(root,'tools/bench-v86',n))).digest('hex')]));
if(config.diagnostic){
    config.kinds=['flags-integer'];
    config.pairs=Array(8).fill('AA');config.order=config.pairs.join('').split('');
    config.protocol='DIAGNOSTIC ONLY: baseline integer; timings are not performance evidence';
    config.diagnosticSources={trace:traceDiagnostic,cpuCounters:cpuDiagnostic};
}
const out=fs.mkdtempSync(path.join(root,`tools/bench-v86/results/${flagsMode?'flag':'x87'}-browser-`));
if(mulpdContract){
    if(flagsMode||config.workerPerArm)throw Error('contract mode must run without benchmark flags');
    config.protocol='correctness only: exact baseline/candidate SSE contract in Worker';
    config.hashes.sseContractCore=createHash('sha256').update(fs.readFileSync(path.join(root,'vendor/v86/tests/sse-flag-contract-core.mjs'))).digest('hex');
    config.hashes.sseFaultCore=createHash('sha256').update(fs.readFileSync(path.join(root,'vendor/v86/tests/sse-move-pagefault-core.mjs'))).digest('hex');
}
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'x87-chrome-'));
let done:(r:any)=>void;
const finished=new Promise(r=>{done=r;});
const mime:Record<string,string>={'.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==='/_x87/config')return Response.json(config);
    if(url.pathname==='/_x87/progress'&&req.method==='POST') {console.log(await req.text());return new Response('ok');}
    if(url.pathname==='/_x87/finish'&&req.method==='POST') {const r=await req.json();done(r);return new Response('ok');}
    if(url.pathname==='/')return new Response(`<!doctype html><title>x87 fixed work</title>
        <script>const fail=e=>fetch('/_x87/finish',{method:'POST',body:JSON.stringify({status:'error',error:String(e.message||e.reason||e)})});
        addEventListener('error',fail);addEventListener('unhandledrejection',fail);</script>
        <script type="module" src="/tools/bench-v86/${driver}"></script>`,{headers:{'content-type':'text/html'}});
    const arm=url.pathname.match(/^\/_x87\/(baseline|candidate|A|B|C)\.wasm$/)?.[1];
    if(arm&&config.arms[arm])return new Response(Bun.file(config.arms[arm].wasm),{headers:{'content-type':'application/wasm'}});
    const file=path.resolve(root,decodeURIComponent(url.pathname).replace(/^\/+/,''));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return new Response('missing',{status:404});
    return new Response(Bun.file(file),{headers:{'content-type':mime[path.extname(file)]||'application/octet-stream'}});
}});
console.log(`OUTPUT ${out}`);
const chrome=spawn(process.env.BS_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless=new',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-extensions',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
    ...(traceDiagnostic?['--trace-startup=v8,v8.execute,devtools.timeline,blink.user_timing,disabled-by-default-v8.cpu_profiler',
        '--trace-startup-duration=15','--trace-startup-format=json',`--trace-startup-file=${path.join(out,'diagnostic-trace.json')}`]:[]),
    `http://127.0.0.1:${server.port}/`],{stdio:'ignore',windowsHide:true});
chrome.on('error',e=>done({status:'error',error:String(e)}));
const sampler=cpuDiagnostic?spawn('powershell',['-NoProfile','-File',path.join(root,'tools/bench-v86/sample-cpu.ps1'),
    '-BrowserPid',String(chrome.pid),'-OutputFile',path.join(out,'cpu-counters.jsonl')],{stdio:'ignore',windowsHide:true}):null;
chrome.on('exit',(code,signal)=>done({status:'error',error:`Chrome exited: ${code}/${signal}`}));
const timer=setTimeout(()=>done({status:'timeout'}),240000);
const result:any=await finished;
clearTimeout(timer);
if(config.affinityRequest){
    // Read back the live runner/browser process family AFTER timing, before cleanup.
    const probe=spawnSync('powershell',['-NoProfile','-Command',
        `$allProcesses=Get-CimInstance Win32_Process; $ids=@(${process.pid},${chrome.pid}); do { $oldCount=$ids.Count; $ids+=@($allProcesses | Where-Object { $_.ParentProcessId -in $ids } | ForEach-Object { $_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $oldCount); Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,@{Name='Mask';Expression={$_.ProcessorAffinity.ToInt64().ToString('X')}} | ConvertTo-Json -Compress`],
        {encoding:'utf8',windowsHide:true});
    result.affinityReadback=probe.status===0?JSON.parse(probe.stdout):{error:probe.stderr};
}
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
sampler?.kill();chrome.kill();server.stop(true);
console.log(JSON.stringify({status:result.status,error:result.error,userAgent:result.userAgent}));
process.exit(result.status==='ok'?0:1);
