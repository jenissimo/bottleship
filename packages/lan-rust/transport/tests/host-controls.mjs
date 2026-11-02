// Transport-layer wire observation only: no Core capability/permission success is implied.
// node host-controls.mjs <exact compat.exe> <new output directory>
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../../../../package.json',import.meta.url)),{io}=require('socket.io-client');
const binary=resolve(process.argv[2]),output=resolve(process.argv[3]);mkdirSync(output,{recursive:false});
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
const files=['packages/lan-rust/transport/src/lib.rs','packages/lan-rust/transport/src/runtime.rs','packages/lan-rust/transport/src/codec.rs','packages/lan-rust/transport/src/budget.rs','packages/lan-rust/transport/examples/compat.rs','packages/lan-rust/transport/Cargo.toml','packages/lan-rust/transport/Cargo.lock',new URL(import.meta.url)];
const fingerprint=()=>Object.fromEntries(files.map(path=>[String(path),sha(path)]));
const before={binary:sha(binary),sources:fingerprint()};save('before.json',before);
copyFileSync(binary,join(output,'compat.exe'));copyFileSync(new URL(import.meta.url),join(output,'client.mjs'));
function finite(promise,name,ms=3000){let timer;return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(name+' deadline')),ms))]).finally(()=>clearTimeout(timer))}
function once(target,name){return finite(new Promise(resolve=>target.once(name,(...args)=>resolve(args))),name)}
const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']}),clients=[],rows=[],serverClosed=[];
async function until(check,name){const end=Date.now()+3000;while(!check()){assert(Date.now()<end,name+' deadline');await new Promise(resolve=>setTimeout(resolve,5))}}
const exit=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});exit.catch(()=>{});
let stdout='',stderr='',failure,forced=false,readyResolve,readyReject;
const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
child.once('error',readyReject);child.stdin.on('error',()=>{});
child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-65536));
const drain=(async()=>{let pending='';for await(const chunk of child.stdout){
 stdout=(stdout+chunk.toString()).slice(-65536);pending+=chunk.toString();
 assert(pending.length<131072,'fixture stdout bound');let at;
 while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const value=JSON.parse(line);if(value.listening)readyResolve(value);if(value.closed&&serverClosed.length<32)serverClosed.push(value.closed)}catch{}}
}})();drain.catch(readyReject);
try{
 const {listening}=await finite(ready,'fixture readiness'),url='http://127.0.0.1:'+listening;
 for(const transport of ['websocket','polling']){
  const socket=io(url,{transports:[transport],upgrade:false,reconnection:false,autoConnect:false,forceNew:true,timeout:2500});clients.push(socket);
  const activated=once(socket,'ready');socket.connect();const [info]=await activated;const sid=socket.io.engine.id;
  const expected=[
   {name:'openUdpHost',args:[1,{proto:1,localPort:47200,bindingGeneration:3,listenerId:'game'}]},
   {name:'cancelUdpHost',args:[1]},
   {name:'releaseUdpHost',args:[9]},
   {name:'openUdpHost',args:[2,null]},
   {name:'cancelUdpHost',args:[]},
  ];
  const received=[];let complete;
  const observed=new Promise(resolve=>complete=resolve);
  socket.on('hostControlObserved',value=>{received.push(value);if(received.length===expected.length)complete()});
  for(const item of expected)socket.emit(item.name,...item.args);
  await finite(observed,'ordered Host controls');
  assert.deepEqual(received,expected.map((item,index)=>({sequence:index+1,...item})));
  rows.push({transport,ordered:received,scope:'transport observation; null/empty arity intentionally not Core-valid'});
  // Existing small metadata cap still applies before parsing or any Core call.
  const closed=once(socket,'disconnect');socket.emit('openUdpHost',3,{listenerId:'x'.repeat(17000)});
  const [reason]=await closed;
  const lookup=await fetch(url+'/socket.io/?EIO=4&transport=polling&sid='+encodeURIComponent(sid),{signal:AbortSignal.timeout(1500)});
  const error=await lookup.json();assert.equal(lookup.status,400);assert.equal(error.code,1);
  await until(()=>serverClosed.some(item=>item.connection===info.connection&&item.reason==='Metadata too large'),'exact metadata retirement');
  rows.at(-1).oversizeMetadataRetired={clientReason:reason,engineSid:sid,lookup:{status:lookup.status,body:error},serverReason:'Metadata too large'};
  save('progress.json',rows);
 }
}catch(error){failure={message:String(error),stack:error.stack};save('first-red.json',failure)}
finally{
 for(const socket of clients)socket.disconnect();child.stdin.end();
 let code;try{code=await finite(exit,'fixture retirement',4000)}catch(error){forced=true;child.kill();code=await exit;failure??={message:String(error)}}
 await drain;
 if(code!==0||forced)failure??={message:'fixture retirement failed',code,forced};
 const after={binary:sha(binary),sources:fingerprint()};save('after.json',after);
 if(JSON.stringify(before)!==JSON.stringify(after))failure??={message:'source/binary changed during proof'};
 writeFileSync(join(output,'stdout.log'),stdout);writeFileSync(join(output,'stderr.log'),stderr);
 const report={status:failure?'FAIL':'PASS',kind:'functional transport wire contract, not benchmark',failure,rows,retirement:{pid:child.pid,code,forced},binary:before.binary,client:require('socket.io-client/package.json').version,node:process.version};
 save('report.json',report);console.log(JSON.stringify({output,...report}));if(failure)process.exitCode=1;
}
