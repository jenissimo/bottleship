// Static helper sites + direct sampled self time. Module samples are NOT helper cost.
// node tools/bench-v86/helper-census.mjs <CDP-corpus-directory> > report.json
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {moduleStats} from '../aot/module-stats.mjs';
import {parseModule} from '../aot/lib/wdis.mjs';
const dir=process.argv[2];
if(!dir)throw Error('Expected CDP corpus directory');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const manifest=read('manifest.json'),scripts=read('scripts.json').scripts,profile=read('profile.json');
const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
const scriptMap=new Map(scripts.map(s=>[String(s.scriptId),s.sha256]));
const engineHash=manifest.loadedRuntimeIdentity?.sha256;
const moduleUs=new Map(),functionUs=new Map();let totalUs=0,unmatchedSamples=0;
for(let i=0;i<(profile.samples??[]).length;i++) {
    const node=nodes.get(profile.samples[i]),us=profile.timeDeltas?.[i];
    if(!node||!Number.isFinite(us)||us<0){unmatchedSamples++;continue;}
    totalUs+=us;
    const frame=node.callFrame,hash=scriptMap.get(String(frame.scriptId));
    if(hash)moduleUs.set(hash,(moduleUs.get(hash)??0)+us);
    if(engineHash&&hash===engineHash)functionUs.set(frame.functionName,(functionUs.get(frame.functionName)??0)+us);
}
const helpers=new Map(),modules=[],unsupported=[];
for(const name of fs.readdirSync(path.join(dir,'modules'))) {
    if(!name.endsWith('.wasm'))continue;
    const bytes=fs.readFileSync(path.join(dir,'modules',name));
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(name!==hash+'.wasm')throw Error('Content hash mismatch '+name);
    try {
        new WebAssembly.Module(bytes);
        if(parseModule(bytes).code?.count!==1)throw Error('Not a single-function JIT module');
        const s=moduleStats(bytes,name);
        const m={sha256:hash,bytes:bytes.length,selfSampleUs:moduleUs.get(hash)??0,calls:s.calls};modules.push(m);
        for(const [helper,sites] of Object.entries(s.calls)) {
            let h=helpers.get(helper);
            if(!h){h={helper,sites:0,modules:0,containingModuleSelfSampleUs:0,directHelperSelfSampleUs:engineHash?(functionUs.get(helper)??0):null};helpers.set(helper,h);}
            h.sites+=sites;h.modules++;h.containingModuleSelfSampleUs+=m.selfSampleUs;
        }
    }catch(error){unsupported.push({sha256:hash,selfSampleUs:moduleUs.get(hash)??0,reason:String(error)});}
}
console.log(JSON.stringify({schema:1,corpus:dir,engine:manifest.loadedRuntimeIdentity??null,totalUs,unmatchedSamples,
    note:'Historical capture, not current runtime validation. Containing-module samples are coverage only, not helper cost or a speedup bound. Direct self samples omit call barriers and secondary optimization effects.',
    helpers:[...helpers.values()].sort((a,b)=>b.directHelperSelfSampleUs-a.directHelperSelfSampleUs||b.sites-a.sites),modules,unsupported},null,2));
