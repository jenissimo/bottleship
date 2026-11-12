import {test,expect,afterEach} from "bun:test";
import {io,type Socket} from "socket.io-client";
import {createPublicLanServer as createLanServer,type LanServer,type LanServerOptions} from "./public-server";
const servers:LanServer[]=[],clients:Socket[]=[];
afterEach(async()=>{for(const c of clients.splice(0))c.disconnect();for(const s of servers.splice(0))await s.close();});
function event(c:Socket,name:string):Promise<any[]>{
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Event timeout: "+name)),1500);c.once(name,(...args)=>{clearTimeout(timer);resolve(args)});});
}
async function start(options:LanServerOptions={}) {const server=createLanServer({port:0,...options});servers.push(server);return {server,port:await server.listen()};}
async function client(port:number,id:number,room="room",transport:"polling"|"websocket"="websocket"){
    const c=io("http://127.0.0.1:"+port,{autoConnect:false,transports:[transport],reconnection:false,
        auth:{version:1,room,clientId:"participant-"+String(id).padStart(8,"0"),node:[2,0,0,0,0,id]}});
    clients.push(c);const ready=event(c,"ready");c.connect();await ready;return c;
}
async function close(server:LanServer,c:Socket){
    const socket=server.io.sockets.sockets.get(c.id!);
    const done=socket?new Promise<void>(resolve=>socket.once("disconnect",()=>resolve())):Promise.resolve();
    c.disconnect();await done;
}
async function barrier(c:Socket){const done=event(c,"resolved");c.emit("resolve",1,{host:"not-configured.test",family:4});await done;}
test("SR-03 successive offline rooms cannot reserve all room capacity",async()=>{
    const {server,port}=await start({maxRooms:2,maxOfflineRooms:1});
    const live=await client(port,1,"live");
    for(let i=2;i<22;i++){const flood=await client(port,2,"flood-"+i);await close(server,flood);}
    const legitimate=await client(port,3,"legitimate");expect(live.connected).toBe(true);expect(legitimate.connected).toBe(true);
});
test("SR-03 offline peer can yield capacity while active peers and reconnect still work",async()=>{
    const {server,port}=await start({maxPeersPerRoom:2,maxOfflineRooms:0});
    const live=await client(port,1),old=await client(port,2);await close(server,old);
    const replacement=await client(port,3);expect(live.connected).toBe(true);expect(replacement.connected).toBe(true);
    await close(server,live);await close(server,replacement);
    const rejoined=await client(port,1);expect(rejoined.connected).toBe(true);
});
for(const transport of ["websocket","polling"] as const) {
    test("SR-04 "+transport+" releasePort flood disconnects only the creator and refunds state",async()=>{
        const {port}=await start({maxBindingsPerPeer:3,maxBindingEntries:4});
        const live=await client(port,1,"room",transport),attacker=await client(port,2,"room",transport);
        const closed=event(attacker,"disconnect");for(let i=1;i<=4;i++)attacker.emit("releasePort",i,1000+i,1);await closed;
        expect(live.connected).toBe(true);
        const next=await client(port,3,"room",transport);for(let i=1;i<=3;i++)next.emit("releasePort",i,2000+i,1);await barrier(next);expect(next.connected).toBe(true);
    });
}
test("SR-04 global state exhaustion preserves other owners and repeated generations reuse a slot",async()=>{
    const {port}=await start({maxBindingsPerPeer:4,maxBindingEntries:3});
    const live=await client(port,1),attacker=await client(port,2);
    for(let generation=1;generation<=50;generation++)live.emit("releasePort",1,1000,generation);
    await barrier(live);expect(live.connected).toBe(true);
    const closed=event(attacker,"disconnect");
    for(let port=2000;port<2003;port++)attacker.emit("releasePort",2,port,1);
    await closed;expect(live.connected).toBe(true);
    const next=await client(port,3);next.emit("releasePort",3,3000,1);next.emit("releasePort",4,3001,1);await barrier(next);expect(next.connected).toBe(true);
});
test("state limits cannot be disabled by invalid configuration values",()=>{
    for(const limits of [{maxBindingsPerPeer:0},{maxBindingEntries:NaN},{maxOfflineRooms:-1},{maxOfflinePeersPerRoom:Infinity}])
        expect(()=>createLanServer(limits)).toThrow();
});
