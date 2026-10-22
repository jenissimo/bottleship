import {createHash} from "node:crypto";
import {join} from "node:path";
const root="logs/lan-conformance/udp-icmp-send-before-drain";
const build=await Bun.file(join(root,"build.json")).json();
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function check(ok:unknown,description:string):asserts ok{if(!ok)throw Error(description);}
async function read(name:string,expected:string){
 const bytes=new Uint8Array(await Bun.file(join(root,name)).arrayBuffer());
 check(sha(bytes)===expected,"Raw reference changed: "+name);
 return JSON.parse(new TextDecoder().decode(bytes));
}
const windows=await read("windows.json",build.windows.outputSha256);
const linux=await read("linux.json",build.linux.outputSha256);
check(build.complete&&windows.nonce===build.nonce&&windows.cases.length===12&&linux.cases.length===4,"Incomplete native references");
function namePort(hex:string){return parseInt(hex.slice(4,8),16);}
function all(hex:string,byte:string){return hex===byte.repeat(hex.length/2);}
const windowsCases=windows.cases.map((value:any)=>{
 const where="Windows "+value.family+"/"+value.resetMode+"/"+value.receiveApi;
 check(value.setup&&value.caseValid&&value.sourcePortUnchanged,where+" setup/ledger");
 check(value.sendBBeforeDrain.result===1&&value.bBeforeDrain.receive.result===1&&!value.retry.attempted,where+" B delivery");
 check(value.bBeforeDrain.receive.payloadHex==="59"+"a5".repeat(15),where+" B payload");
 check(namePort(value.bBeforeDrain.receive.nameHex)===value.clientPort,where+" B saw original bound port");
 const drain=value.errorDrain,reset=value.resetMode!=="off";
 check(drain.result===-1&&drain.lastError===(reset?10054:10035),where+" error code");
 check(drain.nameLength===(reset?(value.family===4?16:28):32),where+" name length");
 if(reset){
  check(value.drainNameMatchesA&&namePort(drain.nameHex)===value.peerAPort,where+" original A tuple");
  check(drain.nameHex.slice(drain.nameLength*2)==="a5".repeat(32-drain.nameLength),where+" unchanged name tail");
 }else check(all(drain.nameHex,"a5"),where+" disabled-reset name sentinel");
 check(all(drain.payloadHex,"a5")&&all(drain.controlHex,"a5"),where+" unchanged output data/control");
 check(drain.bytesOut===0xdeadbeef&&drain.flags===0&&drain.controlLength===64,where+" output scalar sentinels");
 check(value.livePeerReply.receive.result===1&&value.livePeerReply.receive.payloadHex==="52"+"a5".repeat(15),where+" live B reply");
 check(namePort(value.livePeerReply.receive.nameHex)===value.peerBPort,where+" B reply source");
 return {family:value.family,resetMode:value.resetMode,receiveApi:value.receiveApi,
  sendBBeforeDrain:value.sendBBeforeDrain,bReceived:true,receiveError:drain.lastError,
  errorDestination:reset?"A":null,nameLength:drain.nameLength,outputSentinelsPreserved:true,
  retryRequired:false,sourcePortUnchanged:true};
});
const linuxCases=linux.cases.map((value:any)=>{
 const where="Linux "+value.family+"/"+value.drainBeforeSendControl,control=value.drainBeforeSendControl;
 check(value.setup&&value.caseValid&&value.sourcePortUnchanged,where+" setup/ledger");
 check(value.pendingWait.revents===8,where+" pending POLLERR");
 check(value.sendB.result===(control?1:-1)&&value.sendB.errno===(control?0:111),where+" send B outcome");
 const error=value.errorQueue;
 check(error.result===1&&error.extendedErrorFound&&value.drainNameMatchesA&&namePort(error.nameHex)===value.peerAPort,where+" error A tuple");
 check(error.nameLength===(value.family===4?16:28),where+" error name length");
 check(error.eeErrno===111&&error.eeOrigin===(value.family===4?2:3)&&error.eeType===(value.family===4?3:1)&&
  error.eeCode===(value.family===4?3:4),where+" extended error");
 check(error.payloadHex==="78"+"a5".repeat(15),where+" quoted triggering A payload");
 check(error.nameHex.slice(error.nameLength*2)==="a5".repeat(128-error.nameLength),where+" unchanged error name tail");
 check(value.errorQueueAfterDrain.result===-1&&value.errorQueueAfterDrain.errno===11,where+" error queue drained");
 check(value.ordinaryReceiveAfterDrain.result===-1&&value.ordinaryReceiveAfterDrain.errno===11,where+" pending error cleared");
 if(control){
  check(value.bAfterSend.receive.result===1&&!value.retry.attempted,where+" predrain B accepted once");
  check(value.bAfterSend.receive.payloadHex==="59"+"a5".repeat(15),where+" B payload");
 }else{
  const before=value.bAfterSend.receive;
  check(before.result===-1&&before.errno===11&&before.nameLength===128&&all(before.nameHex,"a5")&&all(before.payloadHex,"a5"),where+" B was not sent");
  check(value.retry.attempted&&value.retry.send.result===1&&value.retry.receive.result===1,where+" retained datagram retry");
  check(value.retry.receive.payloadHex==="59"+"a5".repeat(15),where+" retry B payload");
 }
 check(value.livePeerReply.receive.result===1&&value.livePeerReply.receive.payloadHex==="52"+"a5".repeat(15),where+" B reply");
 check(namePort(value.livePeerReply.receive.nameHex)===value.peerBPort,where+" B reply source");
 return {family:value.family,drainBeforeSendControl:control,sendB:value.sendB,bReceivedOnFirstSend:control,
  originalErrorDestination:"A",errorQueueSurvivesFailedSend:control?null:true,eeErrno:error.eeErrno,eeOrigin:error.eeOrigin,
  eeType:error.eeType,eeCode:error.eeCode,retryRequired:!control,retrySucceeded:control?null:true,
  outputNameSentinelsPreserved:true,sourcePortUnchanged:true};
});
const contract={nativeOnly:true,nonce:build.nonce,job:"j236cb6",windowsCases,linuxCases,linuxRelease:linux.release,
 windowsReferenceSha256:build.windows.outputSha256,linuxReferenceSha256:build.linux.outputSha256,
 priorArtifactsUnchanged:build.priorMismatches.length===0,lanPackageUnchanged:build.packageMismatches.length===0,
 helperUnchanged:build.helperUnchanged};
await Bun.write(join(root,"observed-contract.json"),JSON.stringify(contract,null,2)+"\n");
console.log(JSON.stringify(contract));
