/* Isolated Node spawn probe for the native child's CRT fd:3. */
const {spawn} = require("node:child_process");
const {strict:assert} = require("node:assert");
const helper=process.argv[2];
assert(helper);
const child=spawn(helper,["127.0.0.1","0","127.0.0.1","1","19","fd:3"],
    {stdio:["pipe","pipe","pipe","pipe"],windowsHide:true});
const timer=setTimeout(()=>{child.kill();process.exitCode=1;},5000);
let buffer=Buffer.alloc(0),state=0,sawError="";
child.stderr.on("data",b=>{sawError+=b.toString();});
child.stdout.on("data",bytes=>{
    buffer=Buffer.concat([buffer,bytes]);
    while(buffer.length>=16&&buffer.length>=buffer.readUInt32LE(0)) {
        const len=buffer.readUInt32LE(0),frame=buffer.subarray(0,len);buffer=buffer.subarray(len);
        const cmd=(op,id)=>{const x=Buffer.alloc(16);x.writeUInt32LE(16);x[4]=1;x[5]=op;x.writeUInt32LE(id,8);x.writeUInt32LE(19,12);return x;};
        if(state===0&&frame[5]===101){state=1;child.stdio[3].write(cmd(7,1));}
        else if(state===1&&frame[5]===107){state=2;child.stdin.write(cmd(11,2));}
        else if(state===2&&frame[5]===116){state=3;child.stdio[3].write(cmd(12,3));}
        else if(state===3&&frame[5]===117)state=4;
        else {state=-1;child.kill();}
    }
});
child.on("error",e=>{sawError+=String(e);});
child.on("close",(code,signal)=>{
    clearTimeout(timer);
    if(code!==0||signal||state!==4||buffer.length){console.error("fd3 probe failed",{code,signal,state,sawError});process.exitCode=1;return;}
    console.log("Windows Node fd3 helper: ok");
});
