// Prepare a byte-identified pair from two compatible exported AOT caches.
// node build-game-candidate.mjs <original-dir> <candidate-dir> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [original,candidate,out]=process.argv.slice(2);
if(!original||!candidate||!out)throw Error('Expected original-dir candidate-dir output.json');
const read=dir=>JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'));
const a=read(original),c=read(candidate),hash=b=>createHash('sha256').update(b).digest('hex');
if(JSON.stringify(a.version)!==JSON.stringify(c.version))throw Error('AOT version mismatch');
if(a.units.length!==c.units.length)throw Error('Unit count mismatch');
const units=[],seen=new Set();
for(const u of a.units){
    if(u.file!==`${u.entryPage.toString(16)}.wasm`||seen.has(u.file))throw Error('Invalid filename');
    seen.add(u.file);
    const v=c.units.find(v=>v.file===u.file);
    const metadata=({bytes,...rest})=>rest;
    if(!v||JSON.stringify(metadata(u))!==JSON.stringify(metadata(v)))throw Error('Unit metadata mismatch');
    const before=fs.readFileSync(path.join(original,u.file)),after=fs.readFileSync(path.join(candidate,u.file));
    if(before.length!==u.bytes||after.length!==v.bytes||!WebAssembly.validate(before)||!WebAssembly.validate(after))throw Error('Invalid unit bytes');
    if(!before.equals(after))units.push({file:u.file,tableIndex:u.tableIndex,pages:u.pages.map(p=>p.physPage),
        inputSha256:hash(before),outputSha256:hash(after),original:before.toString('base64'),candidate:after.toString('base64')});
}
if(!units.length)throw Error('No changed units');
fs.writeFileSync(out,JSON.stringify({version:a.version,units}));
console.log(JSON.stringify({out,changed:units.length,units:units.map(({original,candidate,...u})=>u)}));
