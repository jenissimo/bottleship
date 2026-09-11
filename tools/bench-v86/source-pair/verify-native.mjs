import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {compare} from './oracle.mjs';

const build = path.resolve(process.argv[2] || 'C:/Projects/bottleship-demos/demo_source_pair');
const direct = await import(pathToFileURL(path.join(build,'web/pair.mjs')));
const module = await direct.default();
const result = {status:'ok',purpose:'correctness only; Node timings are not browser evidence',rows:[]};
try {
    for (const seed of [0,73,0xffffffff]) for(const mode of [0,1,2,3]) {
        const c = {seed,operations:4097,burst:mode===3?1024:257,mode,variable:seed===0?0:1};
        const nativeDir = fs.mkdtempSync(path.join(build,'native-'));
        const output = path.join(nativeDir,'pair-result.bin');
        if(fs.existsSync(output)) throw Error(`${output} already exists; choose a clean native output path`);
        let native;
        try {
            const r = spawnSync(path.join(build,'rom/pair.exe'),Object.values(c).map(String).concat('0'),{cwd:nativeDir,windowsHide:true,timeout:30000});
            if(r.error || r.status!==0) throw Error(`PE failed: ${r.error || r.status}`);
            const b = fs.readFileSync(output);
            native = Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
        } finally { if(fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(nativeDir); }
        const pe = compare(native,c);
        module._pair_init(seed);
        await module.ccall('pair_run',null,['number','number','number','number'],[c.operations,c.burst,c.mode,c.variable],{async:true});
        const p = module._pair_state() >>> 2;
        const wasm = compare(Array.from(module.HEAPU32.subarray(p,p+module._pair_size()/4)),c);
        result.rows.push({config:c,pe,wasm});
    }
} catch(error) { result.status='error';result.error=String(error);process.exitCode=1; }
fs.writeFileSync(path.join(build,'native-correctness.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
