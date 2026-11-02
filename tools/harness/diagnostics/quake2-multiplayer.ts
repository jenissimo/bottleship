/**
 * Two real Quake II clients on an already running dev stack and LAN relay.
 * WGB_HOST and WGB_PEER must be separate game IDs with software/windowed args.
 * Example: bun tools/harness/diagnostics/quake2-multiplayer.ts
 * Results and screenshots go to a fresh logs/quake2-multiplayer-* directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { CdpSession, pageEval } from "../../cdp-core";
import { LanNetwork } from "../../../src/worker/net/lan-network";
import { RelayLink } from "../../../src/worker/net/relay-link";

const web = process.env.BS_DEV_ORIGIN ?? "http://127.0.0.1:5175";
const relay = process.env.BS_LAN_URL ?? "http://127.0.0.1:19001";
const cdp = process.env.BS_CDP_PORT ?? "9333";
const combat = process.env.BS_Q2_COMBAT === "1";
const durationSeconds = Number(process.env.BS_Q2_DURATION_SECONDS ?? 60);
assert(Number.isInteger(durationSeconds) && durationSeconds >= 60 && durationSeconds <= 3600 && durationSeconds % 10 === 0,
  "BS_Q2_DURATION_SECONDS must be a multiple of 10 from 60 to 3600");
const bundleInput = (value:string) => /^https?:\/\//i.test(value) ? value : resolve(value);
const hostBundle = bundleInput(process.env.WGB_HOST ?? "logs/quake2-current/host.wgb");
const peerBundle = bundleInput(process.env.WGB_PEER ?? "logs/quake2-current/peer.wgb");
const runId = Date.now().toString(36);
const output = resolve("logs", "quake2-multiplayer-" + runId);
mkdirSync(output, { recursive: false });
const save = (name: string, value: unknown) => writeFileSync(join(output, name + ".json"), JSON.stringify(value, null, 2));
const owned: {role:string; id:string; session:CdpSession}[] = [];
const net = new LanNetwork();
const packets: {source:number[]; port:number; data:Uint8Array}[] = [];
const observerPort = net.bindEphemeral({deliver: p => { if (packets.length < 512) packets.push({source:Array.from(p.srcNode), port:p.srcPort, data:p.data.slice()}); }}, 1);
assert(observerPort > 0);
const room = "quake2-" + runId;
let link: RelayLink | undefined;
async function tab(role:string) {
  const url = web + "/?game=dev&bs=q2" + role + runId;
  const response = await fetch("http://127.0.0.1:" + cdp + "/json/new?" + encodeURIComponent(url), {method:"PUT"});
  assert(response.ok, "CDP tab creation failed");
  const target:any = await response.json();
  assert(/^[a-f0-9]{16,64}$/i.test(target.id), "Invalid target ID");
  let session:CdpSession;
  try { session = await CdpSession.connect(target.webSocketDebuggerUrl, {timeoutMs:10000}); }
  catch (error) {
    await fetch("http://127.0.0.1:"+cdp+"/json/close/"+encodeURIComponent(target.id)).catch(()=>null);
    throw error;
  }
  owned.push({role,id:target.id,session});
  const end = Date.now()+60000;
  while (Date.now()<end) {
    try { if (await pageEval(session, "Boolean(window.__BS__?.harness && window.loadApp)", {timeoutMs:2000})) return session; } catch {}
    await Bun.sleep(250);
  }
  throw Error(role + " page readiness timeout");
}
async function setup(session:CdpSession) {
  const config = {serverUrl:relay, room};
  const expr = `new Promise((resolve,reject)=>{const worker=window.worker; if(!worker)return reject(Error("No worker"));
    const timer=setTimeout(()=>{worker.removeEventListener("message",done);reject(Error("network timeout"))},20000);
    function done(e){if(e.data?.type!=="network_state")return;const s=e.data.status;if(s.state==="error"){clearTimeout(timer);worker.removeEventListener("message",done);reject(Error(s.reason));}
    else if(s.state==="connected"){clearTimeout(timer);worker.removeEventListener("message",done);resolve(s);}}
    worker.addEventListener("message",done);worker.postMessage({type:"set_network",network:${JSON.stringify(config)}});})`;
  return await pageEval(session,expr,{timeoutMs:25000});
}
async function boot(session:CdpSession, file:string, args?:string) {
  const expression = `window.__BS__.harness.openWgb(${JSON.stringify(file)}, ${JSON.stringify({args})})`;
  return await pageEval(session,expression,{timeoutMs:150000});
}
async function steps(session:CdpSession, list:unknown[]) {
  const result = await pageEval(session, `window.__BS__.harness.__runSteps(${JSON.stringify(list)})`, {timeoutMs:45000});
  assert(result.ok, JSON.stringify(result));
  return result;
}
function parse(data:Uint8Array) {
  if (data.length<10 || !data.subarray(0,4).every(n=>n===255)) return null;
  const text = new TextDecoder("latin1").decode(data.subarray(4)).replace(/\0+$/, "");
  if (!text.startsWith("print\n")) return null;
  const lines=text.slice(6).split(/\r?\n/), info=lines.shift() ?? "";
  const players=lines.filter(Boolean).map(line=>/^(-?\d+)\s+(\d+)\s+"([^"]+)"$/.exec(line));
  if (players.some(p=>!p)) return null;
  return {info, players:players.map(p=>({score:Number(p![1]),ping:Number(p![2]),name:p![3]}))};
}
async function consoleLog(session:CdpSession): Promise<string> {
  const result=await steps(session,[{cmd:"fsRead",args:["C:\\baseq2\\qconsole.log",{encoding:"utf8",maxBytes:262144}]}]);
  return result.named.fsRead.content;
}
async function command(session:CdpSession, text:string) {
  return await steps(session,[{cmd:"key",args:[192]},{cmd:"type",args:[text]},{cmd:"key",args:[13]},{cmd:"key",args:[192]}]);
}
async function waitPosition(session:CdpSession, offset:number) {
  const end=Date.now()+15000;
  while(Date.now()<end) {
    const log=(await consoleLog(session)).slice(offset);
    const match=/\((-?\d+)\s+(-?\d+)\s+(-?\d+)\)\s*:\s*(-?\d+)/.exec(log);
    if(match) return {position:match.slice(1,4).map(Number), yaw:Number(match[4]), log};
    await Bun.sleep(250);
  }
  throw Error("viewpos did not report a position");
}
async function waitLog(session:CdpSession, offset:number, marker:string) {
  const end=Date.now()+90000;
  while(Date.now()<end) {
    const log=await consoleLog(session);
    if(log.slice(offset).includes(marker)) return log;
    await Bun.sleep(1000);
  }
  throw Error("Game log did not reach: "+marker);
}
async function status(node:Uint8Array, expected:string[]) {
  const end=Date.now()+90000;
  while(Date.now()<end) {
    packets.length=0;
    net.send(observerPort,node,27910,Uint8Array.of(255,255,255,255,115,116,97,116,117,115,10),1);
    await Bun.sleep(500);
    for(const p of packets) {
      if(p.port!==27910 || !p.source.every((v,i)=>v===node[i])) continue;
      const reply=parse(p.data);
      if(reply && JSON.stringify(reply.players.map(p=>p.name).sort())===JSON.stringify([...expected].sort())) return reply;
    }
  }
  save("status-timeout", { expected, packets: packets.map(p => ({source:p.source, port:p.port, parsed:parse(p.data)})) });
  throw Error("Quake status missing players: "+expected.join(", "));
}
try {
  link = new RelayLink(relay,room,net); net.attach(link); await link.ready;
  const host=await tab("host"), hn=await setup(host);
  save("host-network",hn);
  const hostArgs="+set vid_ref soft +set vid_fullscreen 0 +set sw_mode 0 +set logfile 2 +set name BSHost +set hostname BSQuake +set dedicated 0 +set port 27910 +set maxclients 4 +set deathmatch 1" + (combat ? " +set cheats 1 +set sv_cheats 1" : "") + " +map demo1";
  await boot(host,hostBundle,hostArgs);
  const hostState = await steps(host,[{cmd:"networkState",args:[]}]);
  save("host-network-state",hostState);
  const hostNode=Uint8Array.from(hostState.named.networkState.node);
  save("host-status",await status(hostNode,["BSHost"]));
  const hostLogBeforePeer=await consoleLog(host);
  const peer=await tab("peer"), pn=await setup(peer); save("peer-network",pn);
  const peerArgs="+set vid_ref soft +set vid_fullscreen 0 +set sw_mode 0 +set logfile 2 +set name BSPeer +connect "+hn.address+":27910";
  await boot(peer,peerBundle,peerArgs);
  save("two-player-status",await status(hostNode,["BSHost","BSPeer"]));
  const entered=await waitLog(host,hostLogBeforePeer.length,"BSPeer entered the game");
  const peerEntered=await waitLog(peer,0,"BSPeer entered the game");
  save("peer-entered",{hostLog:entered.slice(hostLogBeforePeer.length),peerLog:peerEntered});
  if(combat) {
    // Cheats position the peer; disable noclip before firing. No guest bytes are changed.
    async function getPos(session:CdpSession) {
      const offset=(await consoleLog(session)).length;
      await command(session,"viewpos"); return await waitPosition(session,offset);
    }
    async function hold(session:CdpSession, key:number, ms:number) {
      await steps(session,[{cmd:"keyHold",args:[key,Math.round(ms)]}]);
      await Bun.sleep(ms+400);
    }
    const hostPosition=await getPos(host), initialPeerPosition=await getPos(peer);
    const beforeNoclip=await consoleLog(peer);
    await command(peer,"noclip");
    await waitLog(peer,beforeNoclip.length,"noclip ON");
    await command(peer,"bind z +movedown");
    const rad=hostPosition.yaw*Math.PI/180;
    const target=[hostPosition.position[0]+90*Math.cos(rad),hostPosition.position[1]+90*Math.sin(rad),hostPosition.position[2]];
    let position=await getPos(peer);
    const navigation=[];
    for(let i=0;i<40;i++) {
      const dx=target[0]-position.position[0],dy=target[1]-position.position[1],distance=Math.hypot(dx,dy);
      if(distance<20) break;
      const desired=Math.atan2(dy,dx)*180/Math.PI;
      const angle=((desired-position.yaw+540)%360)-180;
      navigation.push({position,desired,distance,angle});
      console.log("combat navigation",i,Math.round(distance),Math.round(angle));
      if(Math.abs(angle)>12) await hold(peer,angle>0?37:39,Math.min(1200,Math.max(80,Math.abs(angle)*1000/140)));
      else await hold(peer,38,Math.min(5000,Math.max(80,(distance-8)*1000/240)));
      position=await getPos(peer);
    }
    assert(Math.hypot(target[0]-position.position[0],target[1]-position.position[1])<30,"Combat horizontal rendezvous failed");
    for(let i=0;i<12;i++) {
      const dz=target[2]-position.position[2]; if(Math.abs(dz)<18) break;
      await hold(peer,dz>0?32:90,Math.min(2000,Math.max(50,Math.abs(dz)*1000/220)));
      position=await getPos(peer);
    }
    save("combat-position",{hostPosition,initialPeerPosition,target,navigation,final:position});
    assert(Math.abs(target[2]-position.position[2])<25,"Combat vertical rendezvous failed");
    const beforeOff=await consoleLog(peer);
    await command(peer,"noclip");
    await waitLog(peer,beforeOff.length,"noclip OFF");
    await Bun.sleep(1500);
    const beforeFire=await consoleLog(host);
    await hold(host,17,8000);
    const fireLog=await waitLog(host,beforeFire.length,"BSPeer was blasted by BSHost");
    const fireStatus=await status(hostNode,["BSHost","BSPeer"]);
    save("combat",{hostLog:fireLog.slice(beforeFire.length),status:fireStatus});
    assert.equal(fireStatus.players.find(p=>p.name==="BSHost")?.score,1,"Combat did not award the frag");
    await hold(peer,17,1000);
  }
  const beforeMove=await consoleLog(peer);
  await command(peer,"viewpos");
  const firstPosition=await waitPosition(peer,beforeMove.length);
  const beforeSecond=await consoleLog(peer);
  await steps(peer,[{cmd:"keyHold",args:[40,2000]}]); await Bun.sleep(2500);
  await command(peer,"viewpos");
  const secondPosition=await waitPosition(peer,beforeSecond.length);
  save("movement",{firstPosition,secondPosition});
  assert.notDeepEqual(firstPosition.position.slice(0,2),secondPosition.position.slice(0,2),"Peer did not move horizontally");
  // Quake rejects suicide immediately after a spawn.
  await Bun.sleep(5000);
  const preKill=await consoleLog(host);
  await command(peer,"kill");
  const killed=await waitLog(host,preKill.length,"BSPeer killed himself.");
  const deathStatus=await status(hostNode,["BSHost","BSPeer"]);
  assert.equal(deathStatus.players.find(p=>p.name==="BSPeer")?.score,-1,"Death did not update the server score");
  save("death",{hostLog:killed.slice(preKill.length),status:deathStatus});
  await steps(peer,[{cmd:"keyHold",args:[17,1000]}]); await Bun.sleep(1500);
  const beforeRespawnPosition=await consoleLog(peer);
  await command(peer,"viewpos");
  const respawn=await waitPosition(peer,beforeRespawnPosition.length);
  const beforeRespawnMove=await consoleLog(peer);
  await steps(peer,[{cmd:"keyHold",args:[40,2000]}]); await Bun.sleep(2500);
  await command(peer,"viewpos");
  const respawnMoved=await waitPosition(peer,beforeRespawnMove.length);
  save("respawn-position",{respawn,respawnMoved});
  assert.notDeepEqual(respawn.position.slice(0,2),respawnMoved.position.slice(0,2),"Peer could not move after respawn");
  const preDisconnect=await consoleLog(host);
  // Disconnect returns to the console. Do not toggle it closed afterwards:
  // typing the reconnect command into the menu can start a single-player game.
  await steps(peer,[{cmd:"key",args:[192]},{cmd:"type",args:["disconnect"]},{cmd:"key",args:[13]}]);
  save("disconnected-status",await status(hostNode,["BSHost"]));
  const peerLogBeforeReconnect=await consoleLog(peer);
  await steps(peer,[{cmd:"type",args:["connect "+hn.address+":27910"]},{cmd:"key",args:[13]}]);
  save("reconnected-status",await status(hostNode,["BSHost","BSPeer"]));
  const reentered=await waitLog(host,preDisconnect.length,"BSPeer entered the game");
  const peerReentered=await waitLog(peer,peerLogBeforeReconnect.length,"BSPeer entered the game");
  save("reconnected",{hostLog:reentered.slice(preDisconnect.length),peerLog:peerReentered.slice(peerLogBeforeReconnect.length)});
  const beforeSustain=await Promise.all(owned.map(item=>steps(item.session,[{cmd:"renderBoundaryMark",args:[]}])));
  const checks=[];
  const sustainStart=Date.now();
  for(let i=0;i<durationSeconds/10;i++) {
    if(combat) {
      // Keep exercising client input and projectile traffic throughout the observation.
      await Promise.all([
        steps(peer,[{cmd:"keyHold",args:[i%2 ? 38 : 40,1000]}]),
        steps(host,[{cmd:"keyHold",args:[17,1000]}]),
      ]);
    }
    await Bun.sleep(10000);
    checks.push(await status(hostNode,["BSHost","BSPeer"]));
    console.log("sustained match", (i+1)*10, "seconds");
  }
  const afterSustain=await Promise.all(owned.map(item=>steps(item.session,[{cmd:"renderBoundaryMark",args:[]}])));
  const frames=owned.map((item,i)=>({role:item.role,before:beforeSustain[i].named.renderBoundaryMark.guestPresentSerial,after:afterSustain[i].named.renderBoundaryMark.guestPresentSerial}));
  save("sustained",{requestedSeconds:durationSeconds,elapsedMs:Date.now()-sustainStart,checks,frames});
  for(const frame of frames) assert(frame.after>frame.before,frame.role+" stopped presenting during the sustained match");
  for(const item of owned) {
    save(item.role+"-state",await steps(item.session,[{cmd:"state",args:[["screen","windows"]]},{cmd:"renderBoundaryMark",args:[]}]));
    const shot:any=await item.session.send("Page.captureScreenshot",{format:"png"},undefined,{timeoutMs:10000});
    writeFileSync(join(output,item.role+".png"),Buffer.from(shot.result.data,"base64"));
  }
  console.log("Connected two players. Evidence: "+output);
} catch(error) {
  save("failure",{error:String(error),stack:error instanceof Error?error.stack:undefined});
  for (const item of owned) {
    try { save(item.role+"-failure-state", await steps(item.session,[{cmd:"networkState",args:[]},{cmd:"state",args:[["screen","windows"]]},{cmd:"fsRead",args:["C:\\\\baseq2\\\\qconsole.log",{encoding:"utf8",maxBytes:262144}]}])); } catch (e) { save(item.role+"-failure-state-error",String(e)); }
    try { const shot:any=await item.session.send("Page.captureScreenshot",{format:"png"},undefined,{timeoutMs:10000}); writeFileSync(join(output,item.role+"-failure.png"),Buffer.from(shot.result.data,"base64")); } catch (e) { save(item.role+"-failure-shot-error",String(e)); }
  }
  throw error;
} finally {
  net.attach(null); net.reset();
  for(const item of owned.reverse()) {
    item.session.close();
    const response=await fetch("http://127.0.0.1:"+cdp+"/json/close/"+encodeURIComponent(item.id)).catch(()=>null);
    console.log("closed own tab",item.role,item.id,response?.status);
  }
}
