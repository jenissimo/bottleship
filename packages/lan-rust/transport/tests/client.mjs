// Functional compatibility/retirement proof; not a performance benchmark.
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {strict as assert} from 'node:assert';
const require=createRequire(new URL('../../../../package.json',import.meta.url)),{io}=require('socket.io-client');
const dir='packages/lan-rust/transport';
const sourceSnapshot=process.argv[2]??null;
const attempt='logs/lan-conformance/rust-transport-spike/patched-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
mkdirSync(attempt,{recursive:false});
const binary=resolve(dir,'target/debug/examples/compat.exe'),rows=[],clients=[],events=[];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{let end=Date.now()+2500;while(!fn()){if(Date.now()>end)throw Error('finite condition deadline');await pause(10)}};
function once(emitter,name,ms=2500){return new Promise((resolve,reject)=>{const done=(...v)=>{clearTimeout(timer);emitter.off(name,done);resolve(v)};const timer=setTimeout(()=>{emitter.off(name,done);reject(Error('timeout '+name))},ms);emitter.on(name,done)})}
const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
const exit=new Promise((r,j)=>{child.once('exit',r);child.once('error',j)});
let stdout='',stderr='',failure,base,rawWs;
child.stderr.on('data',c=>stderr=(stderr+c.toString()).slice(-65536));
let readyResolve;const started=new Promise(r=>readyResolve=r);
const drain=(async()=>{let pending='';for await(const c of child.stdout){stdout=(stdout+c.toString()).slice(-65536);pending+=c.toString();let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const v=JSON.parse(line);events.push(v);if(v.listening)readyResolve(v)}catch{}}}})();
async function connect(mode){
 const s=io(base,{transports:mode==='upgrade'?['polling','websocket']:[mode],upgrade:false,reconnection:false,timeout:2500,autoConnect:false,forceNew:true});clients.push(s);
 const ready=once(s,'ready'),connected=once(s,'connect');s.connect();await connected;await ready;
 return s;
}
async function echo(s){
 for(const length of [0,1,65535,65552]){
  const data=Buffer.alloc(length);for(let n=0;n<length;n++)data[n]=(n*31+7)&255;
  const next=once(s,'frame');s.emit('frame',data);const args=await next;
  assert.equal(args.length,1,'generation None must be omitted');assert.deepEqual(Buffer.from(args[0]),data);
 }
}
async function lookup(sid){const r=await fetch(base+'/socket.io/?EIO=4&transport=polling&sid='+encodeURIComponent(sid),{signal:AbortSignal.timeout(1000)});return{status:r.status,body:await r.text()}}
try{
 const info=await Promise.race([started,pause(3000).then(()=>{throw Error('startup deadline')})]);base='http://127.0.0.1:'+info.listening;
 for(const mode of ['polling','websocket','upgrade']){
  const s=await connect(mode),engine=s.io.engine,before={engine:engine.id,socket:s.id,transport:engine.transport.name};
  assert.equal(before.transport,mode==='websocket'?'websocket':'polling');await echo(s);
  if(mode==='upgrade'){const upgraded=once(engine,'upgrade');engine.opts.upgrade=true;engine._probe('websocket');await upgraded;await echo(s);}
  const after={engine:engine.id,socket:s.id,transport:engine.transport.name};
  assert.equal(after.engine,before.engine);assert.equal(after.socket,before.socket);
  rows.push({case:mode,before,after,binaryLengths:[0,1,65535,65552]});s.disconnect();
 }
 // No polling GET after this bounded setup.
 const open=await(await fetch(base+'/socket.io/?EIO=4&transport=polling')).text(),sid=JSON.parse(open.slice(1)).sid;
 const url=base+'/socket.io/?EIO=4&transport=polling&sid='+sid;
 const post=async body=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body,signal:AbortSignal.timeout(1500)});assert.equal(r.status,200);await r.text()};
 await post('40{}');let socketId;
 for(let n=0;n<4&&!socketId;n++){const body=await(await fetch(url,{signal:AbortSignal.timeout(1500)})).text();for(const p of body.split(String.fromCharCode(30))){if(p==='2')await post('3');else if(p.startsWith('40'))socketId=JSON.parse(p.slice(2)).sid;}}
 assert.ok(socketId);await post('42["flood"]');
 await until(()=>events.some(e=>e.flood?.connection===Number(socketId)));
 const polling=events.find(e=>e.flood?.connection===Number(socketId)).flood;
 assert.equal(polling.refused,true);assert.equal(polling.retired,true);assert.equal(polling.afterRecords,0);assert.equal(polling.afterBytes,0);
 const pollLookup=await lookup(sid);assert.equal(pollLookup.status,400);assert.equal(JSON.parse(pollLookup.body).code,1);rows.push({case:'permanent-no-GET-polling',engine:sid,...polling,lookup:pollLookup});
 const s=await connect('websocket'),wsEngine=s.io.engine.id,id=s.id;
 rawWs=s.io.engine.transport.ws._socket;rawWs.pause();s.emit('flood');
 await until(()=>events.some(e=>e.flood?.connection===Number(id)));
 const ws=events.find(e=>e.flood?.connection===Number(id)).flood;
 assert.equal(ws.refused,true);assert.equal(ws.retired,true);assert.equal(ws.afterRecords,0);assert.equal(ws.afterBytes,0);
 const wsLookup=await lookup(wsEngine);assert.equal(wsLookup.status,400);assert.equal(JSON.parse(wsLookup.body).code,1);
 rows.push({case:'paused-real-WS-TCP-reader',engine:wsEngine,...ws,lookup:wsLookup,clientDestroyedBeforeResume:rawWs.destroyed});
 rawWs.resume();rawWs.destroy();rawWs=undefined;s.disconnect();
 const denied=io(base,{transports:['websocket'],reconnection:false,autoConnect:false,forceNew:true,auth:{deny:true}});clients.push(denied);
 const rejected=once(denied,'connect_error');denied.connect();const [reason]=await rejected;
 assert.equal(reason.message,'Rejected');rows.push({case:'authorization-rejection-before-connect-ack',message:reason.message});
 const malformed=await lookup('bad');assert.equal(malformed.status,400);rows.push({case:'malformed-sid-no-replacement',...malformed});
}catch(e){failure={message:String(e),stack:e.stack}}
finally{
 rawWs?.destroy();for(const s of clients)s.disconnect();child.stdin.end();
 const code=await Promise.race([exit,pause(4000).then(()=>null)]),forced=code===null;
 if(forced)child.kill();const actual=await exit;await drain;
 if((forced||actual!==0)&&!failure)failure={message:'server cleanup failed',forced,actual};
 const files=[dir+'/src/lib.rs',dir+'/src/runtime.rs',dir+'/src/codec.rs',dir+'/src/budget.rs',dir+'/Cargo.toml',dir+'/Cargo.lock',binary];
 const sources=Object.fromEntries(files.map(p=>[p,sha(p)]));
 copyFileSync(binary,attempt+'/compat.exe');copyFileSync(dir+'/tests/client.mjs',attempt+'/client.mjs');
 writeFileSync(attempt+'/server.log',stdout+'\nSTDERR\n'+stderr);
 const report={sourceSnapshot,status:failure?'FAIL':'PASS',kind:'functional/ownership compatibility, not benchmark',rows,failure,forced,exit:actual,node:process.version,client:require('socket.io-client/package.json').version,sources};
 writeFileSync(attempt+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({attempt,...report}));
}
if(failure)process.exitCode=1;
