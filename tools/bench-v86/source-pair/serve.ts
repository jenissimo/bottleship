import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {analyze} from '../analyze-jit-wasm.mjs';
import {spawnSync} from 'node:child_process';
import {inlineRotate} from '../../aot/lib/inline-rotate.mjs';
import {specializeShufpsCalls} from '../../aot/lib/shufps-specialize.mjs';

const repo=path.resolve(import.meta.dir,'../../..');
const build=path.resolve(process.argv[2]||'C:/Projects/bottleship-demos/demo_source_pair');
const out=fs.mkdtempSync(path.join(repo,'logs','source-pair-'));
const served=path.join(repo,'public/apps/source-pair-lab');
fs.mkdirSync(served,{recursive:true});
for(const name of ['direct-worker.mjs','oracle.mjs']) fs.copyFileSync(path.join(import.meta.dir,name),path.join(served,name));
const manifest=JSON.parse(fs.readFileSync(path.join(build,'build.json'),'utf8'));
for(const [source,dest] of [['pair.wgb','pair.wgb'],['web/pair.mjs','pair.mjs'],['web/pair.wasm','pair.wasm']]) {
    const bytes=fs.readFileSync(path.join(build,source));
    if(createHash('sha256').update(bytes).digest('hex')!==manifest.artifacts[source].sha256) throw Error(`Build drift: ${source}`);
    fs.writeFileSync(path.join(served,dest),bytes);
}
fs.copyFileSync(path.join(build,'build.json'),path.join(out,'build.json'));
const git=(args:string[])=>spawnSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).stdout;
const provenance={head:git(['rev-parse','HEAD']).trim(),v86Head:git(['-C','vendor/v86','rev-parse','HEAD']).trim(),
    runtimeDiskSha256:createHash('sha256').update(fs.readFileSync(path.join(repo,'public/v86.wasm'))).digest('hex'),
    loadedRuntimeIdentity:'disk hash only; not a CDP verification of instantiated bytes',
    dirtyDiffSha256:createHash('sha256').update(git(['diff','--binary'])).digest('hex'),
    status:git(['status','--short']),note:'Untracked source contents are not covered by the dirty diff hash.'};
fs.writeFileSync(path.join(out,'runtime-provenance.json'),JSON.stringify(provenance,null,2));
let submission=0;
const allowedOrigin=process.env.SOURCE_PAIR_ORIGIN||'http://localhost:5174';
if(!['http://localhost:5174','http://127.0.0.1:5174'].includes(allowedOrigin))throw Error('Unsupported lab origin');
const headers={'Access-Control-Allow-Origin':allowedOrigin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:32*1024*1024,async fetch(req){
    if(req.headers.get('origin')!==allowedOrigin) return new Response('origin refused',{status:403});
    if(req.method==='OPTIONS') return new Response(null,{headers});
    if(req.method==='POST'&&['/transform','/transform-shufps'].includes(new URL(req.url).pathname)) {
        try {
            const bytes=Buffer.from(await req.arrayBuffer()),engine=fs.readFileSync(path.join(repo,'public/v86.wasm'));
            const r=new URL(req.url).pathname==='/transform-shufps'?specializeShufpsCalls(bytes,engine):inlineRotate(bytes,engine);
            return Response.json({base64:r.bytes.toString('base64'),sites:r.sites,engineSha256:r.engineSha256,
                inputSha256:createHash('sha256').update(bytes).digest('hex'),outputSha256:createHash('sha256').update(r.bytes).digest('hex')},{headers});
        } catch(error) {return Response.json({error:String(error)},{status:400,headers});}
    }
    if(req.method!=='POST'||new URL(req.url).pathname!=='/result') return new Response('not found',{status:404,headers});
    const data=await req.json();
    if(data?.schema!==1||!Array.isArray(data.rows)||data.rows.length>16) return new Response('invalid',{status:400,headers});
    const dir=path.join(out,data.mode==='game-paired'?'game-paired':data.mode==='game-shot'?'game-shot':data.mode==='game-capture'?'game-capture':data.mode==='full-runtime-correctness'?'full':data.mode==='paired-rotate'?'paired':data.mode==='shufps-browser'?'shufps-browser':'direct');
    fs.mkdirSync(dir,{recursive:true});
    for(const [i,row] of data.rows.entries()) {
        if(row.shot?.base64)fs.writeFileSync(path.join(dir,`${i}.png`),Buffer.from(row.shot.base64,'base64'));
        if(row.aot) {
            const cache=path.join(dir,String(i),'aot-original');fs.mkdirSync(cache,{recursive:true});
            const units=row.aot.units.map(u=>{
                if(u.file!==`${u.entryPage.toString(16)}.wasm`)throw Error('Invalid AOT filename');
                const {base64,sha256,...unit}=u;const bytes=Buffer.from(base64,'base64');
                if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('AOT hash mismatch');
                fs.writeFileSync(path.join(cache,u.file),bytes);return unit;
            });
            fs.writeFileSync(path.join(cache,'index.json'),JSON.stringify({version:row.aot.version,units},null,2));
        }
        if(!row.publications) continue;
        const modules=path.join(dir,String(i),'modules');fs.mkdirSync(modules,{recursive:true});
        const reports=[];
        for(const m of row.publications.modules||[]) {
            const bytes=Buffer.from(m.base64,'base64'),sha=createHash('sha256').update(bytes).digest('hex');
            if(sha!==m.sha256) return new Response('hash mismatch',{status:400,headers});
            fs.writeFileSync(path.join(modules,`${sha}.wasm`),bytes);
            try {reports.push({sha256:sha,report:analyze(bytes)});} catch(error) {reports.push({sha256:sha,unsupported:String(error)});}
        }
        fs.writeFileSync(path.join(dir,String(i),'static.json'),JSON.stringify(reports,null,2));
    }
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(data,null,2));
    fs.writeFileSync(path.join(dir,`checkpoint-${++submission}.json`),JSON.stringify(data,null,2));
    console.log(JSON.stringify({status:data.status,mode:data.mode,rows:data.rows.length,error:data.error,out:dir}));
    return new Response('saved',{headers});
}});
fs.writeFileSync(path.join(served,'config.json'),JSON.stringify({build:manifest,collector:`http://127.0.0.1:${server.port}/result`}));
console.log(JSON.stringify({url:'http://localhost:5174/tools/bench-v86/source-pair/browser.html',out,collectorPort:server.port}));
