// Extract a named exported function body without changing or executing the module.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const file=process.argv[2],name=process.argv[3],bytes=fs.readFileSync(file);
const importedFunctions=WebAssembly.Module.imports(new WebAssembly.Module(bytes)).filter(x=>x.kind==='function').length;
let p=8,index,body;
const u32=()=>{let n=0,shift=0,b;do{b=bytes[p++];n|=(b&127)<<shift;shift+=7;if(shift>35)throw Error('bad LEB');}while(b&128);return n>>>0;};
while(p<bytes.length){
    const section=bytes[p++],size=u32(),end=p+size;
    if(section===7){
        const count=u32();
        for(let i=0;i<count;i++){
            const length=u32(),exportName=bytes.toString('utf8',p,p+length);p+=length;
            const kind=bytes[p++],exportIndex=u32();
            if(exportName===name&&kind===0)index=exportIndex;
        }
    }
    if(section===10){
        const count=u32();
        for(let i=0;i<count;i++){
            const length=u32(),endBody=p+length;
            if(i===index-importedFunctions)body=[...bytes.subarray(p,endBody)];
            p=endBody;
        }
    }
    p=end;
}
if(!body)throw Error('defined function export not found');
console.log(JSON.stringify({file,hash:createHash('sha256').update(bytes).digest('hex'),name,index,importedFunctions,body},null,2));
