import {createHash} from "node:crypto";
const directory="logs/lan-conformance/udp-icmp-tuple-native";
const build=await Bun.file(directory+"/build.json").json();
const bytes=new Uint8Array(await Bun.file(build.reference).arrayBuffer()),view=new DataView(bytes.buffer);
if(view.getUint32(0,true)!==0x42534c4e||view.getUint32(4,true)*4!==bytes.length||view.getUint32(8,true)!==build.nonce||
    createHash("sha256").update(bytes).digest("hex")!==build.referenceSha256)throw Error("Invalid native reference");
const data=Array.from({length:bytes.length/4-3},(_,i)=>view.getUint32((i+3)*4,true));
if(data.length!==1082)throw Error("Unexpected native UDP schema length "+data.length);
const signed=(n:number)=>n|0;
const hex=(words:number[])=>{const b=new Uint8Array(words.length*4),v=new DataView(b.buffer);words.forEach((word,i)=>v.setUint32(i*4,word,true));return Buffer.from(b).toString("hex");};
const cases=[];
for(let i=0;i<12;i++){
    const row=data.slice(1+i*90,1+(i+1)*90),marker=row[0]!,first=row[46]!;
    const family=marker&0x100?6:4,mode=["default","on","off"][(marker>>4)&3]!,api=marker&1?"WSARecvMsg":"recvfrom";
    if((marker&0xfffffe00)!==0x55445000)throw Error("Unexpected case marker");
    const nameFamily=first&0xffff,namePort=((first>>>16)&255)*256+(first>>>24);
    cases.push({family,mode,api,ports:{closedA:row[8],liveB:row[9],client:row[10]},
        setupSucceeded:row[1]===1&&[2,4,6,11].every(offset=>row[offset]===0),
        resetOption:{attempted:!!row[13],result:signed(row[14]!),error:row[15],returnedBytes:row[16]},
        extension:{result:signed(row[17]!),error:row[18],available:!!row[19]},
        closedSend:{result:signed(row[30]!),error:row[31]},
        readiness:{result:signed(row[32]!),error:row[33],readable:!!row[34],exceptional:!!row[35]},
        errorReceive:{result:signed(row[36]!),error:row[37],bytesOut:row[38],nameLength:row[39],flags:row[40],controlLength:row[41],
            sameNamePointer:!!row[42],sameControlPointer:!!row[43],bufferLength:row[44],bufferCount:row[45],
            nameFamily,namePort,closedDestinationPortReturned:namePort===row[8],livePeerPortReturned:namePort===row[9],
            nameHex:hex(row.slice(46,54)),payloadHex:hex(row.slice(54,58)),controlHex:hex(row.slice(58,74))},
        livePeerControl:{sendResult:signed(row[74]!),sendError:row[75],readiness:signed(row[76]!),receiveResult:signed(row[80]!),receiveError:row[81],
            payloadMatches:!!row[82],nameLength:row[83],nameFamily:row[84],sourceMatchesB:!!row[85]},
        rawWords:row});
}
const report={nativeOnly:true,fixture:build.fixture,nonce:build.nonce,executableSha256:build.executableSha256,referenceSha256:build.referenceSha256,
    sourceSha256:createHash("sha256").update(new Uint8Array(await Bun.file("tools/lan-conformance/udp-icmp-tuple-native.c").arrayBuffer())).digest("hex"),
    startup:data[0],cleanup:data.at(-1),observationCount:data.length,cases};
await Bun.write(directory+"/windows-observed-contract.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({nonce:build.nonce,observations:data.length,cases:cases.map(({family,mode,api,errorReceive,livePeerControl})=>({
    family,mode,api,result:errorReceive.result,error:errorReceive.error,nameLength:errorReceive.nameLength,nameFamily:errorReceive.nameFamily,
    closedDestinationPortReturned:errorReceive.closedDestinationPortReturned,nameHex:errorReceive.nameHex,bytesOut:errorReceive.bytesOut,
    flags:errorReceive.flags,controlLength:errorReceive.controlLength,livePeerControl}))},null,2));
