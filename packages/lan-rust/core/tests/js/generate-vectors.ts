// Differential fixtures are evaluated by the maintained TS reference, never copied validators.
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {decodeDatagram,validBindingGeneration} from "../../../../lan/src/protocol";
function vector(name:string,length:number,prefix:number[],fill=0){const bytes=new Uint8Array(length).fill(fill);bytes.set(prefix.slice(0,length));const d=decodeDatagram(bytes);return{name,length,prefix,fill,expected:d?{proto:d.proto,node:Array.from(d.node),dstPort:d.dstPort,srcPort:d.srcPort,payloadLength:d.payload.length}:null};}
const header=(proto:number,dst=9000,src=2000)=>[2,proto,2,0,0,0,0,1,dst>>>8,dst&255,src>>>8,src&255];
const frames=[];
for(let size=0;size<=14;size++)frames.push(vector("short-"+size,size,header(1)));
for(const proto of [0,1,2,3,4,5,6,7,8]){
 const max=proto===0?548:proto===4?65527:proto===6||proto===7?65540:65507;
 const prefix=header(proto,proto>=6?2:9000,proto>=6?256:2000);
 if(proto===6||proto===7)prefix.push(1,2,255,0,0); // valid options header + maximum raw packet
 frames.push(vector("maximum-"+proto,12+max,prefix),vector("oversize-"+proto,13+max,prefix));
}
for(const flags of [0,1,2,3,4])frames.push(vector("raw-flags-"+flags,18,[...header(6,2,256),1,flags,255,0,0]));
for(const ttl of [-2,-1,0,255,256])frames.push(vector("raw-ttl-"+ttl,18,[...header(6,2,256),1,2,ttl&255,(ttl>>8)&255,0]));
frames.push(vector("ipx-needs-two-metadata-bytes",13,[...header(0),0]),vector("zero-dst",12,header(1,0)),vector("zero-src",12,header(1,1,0)),vector("wrong-kind",12,[3,...header(1).slice(1)]));
const generations=[null,0,1,-1,1.5,4294967295,4294967296].map(value=>({value,valid:validBindingGeneration(value)}));
const output={reference:"packages/lan/src/protocol.ts",generationOmittedIsLegacy:true,frames,generations};
writeFileSync(fileURLToPath(new URL("../wire-vectors.json",import.meta.url)),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify({frames:frames.length,generations:generations.length}));
