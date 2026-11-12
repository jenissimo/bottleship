import {test,expect,afterEach} from "bun:test";
import {io,type Socket} from "socket.io-client";
import {createSocket} from "node:dgram";
import {createLanServer,type LanServer} from "../src/server";
import {RoomAccess} from "../src/access";
import {encodeDatagram} from "../src/protocol";
import vector from "./invite-vector.json";
const key=Buffer.from(vector.keyBase64,"base64");
const envName="BOTTLESHIP_LAN_ACCESS_REGRESSION_TEST_KEY";
const servers:LanServer[]=[],clients:Socket[]=[];
afterEach(async()=>{for(const c of clients.splice(0))c.disconnect();for(const s of servers.splice(0))await s.close();delete process.env[envName];});
function event(c:Socket,name:string):Promise<any[]> {
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.off(name,done);reject(new Error("Event timeout: "+name))},1500);const done=(...args:any[])=>{clearTimeout(timer);resolve(args)};c.once(name,done);});
}
async function start(gateway?:NonNullable<Parameters<typeof createLanServer>[0]>["gateway"]) {
    process.env[envName]=vector.keyBase64;
    const server=createLanServer({port:0,roomAccess:{inviteKeyEnv:envName,rooms:{lobby:{visibility:"public"}}},gateway});
    servers.push(server);return await server.listen();
}
function client(port:number,room:string,transport:"polling"|"websocket",invite?:string,node=1) {
    const c=io("http://127.0.0.1:"+port,{autoConnect:false,transports:[transport],reconnection:false,auth:{version:1,room,clientId:"participant-0000000"+node,node:[2,0,0,0,0,node],...(invite?{invite}:{})}});
    clients.push(c);return c;
}
for(const transport of ["websocket","polling"] as const) {
    test("SR-01 "+transport+" rejects unsigned private room and accepts explicit public room",async()=>{
        const port=await start();const denied=client(port,"locked",transport);const error=event(denied,"connect_error");denied.connect();expect((await error)[0].message).toBe("LAN access denied");
        const publicClient=client(port,"lobby",transport);const ready=event(publicClient,"ready");publicClient.connect();expect((await ready)[0].version).toBe(1);
        const access=new RoomAccess({},key),now=Math.floor(Date.now()/1000);
        const admitted=client(port,"locked",transport,access.sign("locked",now+60),2);const accepted=event(admitted,"ready");admitted.connect();expect((await accepted)[0].version).toBe(1);
        const wrong=client(port,"other",transport,access.sign("locked",now+60),3);const rejected=event(wrong,"connect_error");wrong.connect();expect((await rejected)[0].message).toBe("LAN access denied");
    });
    test("SR-02 "+transport+" anonymous client cannot use native UDP/DNS/listener but scoped invitation can",async()=>{
        const udp=createSocket("udp4");await new Promise<void>(r=>udp.bind(0,"127.0.0.1",r));
        try {
            const nativePort=(udp.address() as {port:number}).port;
            const port=await start({routes:[{id:"quake",host:"127.0.0.1",address:"203.0.113.10",names:["game.test"],ports:[nativePort],protocols:["udp"]}],
                tcpListeners:[{id:"host",bindHost:"127.0.0.1",advertisedHost:"127.0.0.1",port:0,allowedHosts:["127.0.0.1"]}]});
            const attacker=client(port,"lobby",transport);const r=event(attacker,"ready");attacker.connect();expect((await r)[0].gatewayIpv4).toEqual([]);
            let packets=0;udp.on("message",()=>packets++);
            const frame=encodeDatagram(1,Uint8Array.of(2,1,203,0,113,10),nativePort,25000,Uint8Array.of(7,8,9));
            const denied=event(attacker,"socketError");attacker.emit("frame",frame,1);expect((await denied)[0].code).toBe(10013);
            const dns=event(attacker,"resolved");attacker.emit("resolve",1,{host:"game.test",family:4});expect((await dns)[1].error.code).toBe("ACCESS_DENIED");
            const host=event(attacker,"tcpHostOpened");attacker.emit("openTcpHost",1,{proto:2,localPort:25001,bindingGeneration:1,listenerId:"host"});expect((await host)[1].error.code).toBe(10013);
            expect(packets).toBe(0);
            const token=new RoomAccess({},key).sign("locked",Math.floor(Date.now()/1000)+60,{routes:["quake"]});
            const authorized=client(port,"locked",transport,token,2);const ready=event(authorized,"ready");authorized.connect();expect((await ready)[0].gatewayIpv4).toEqual([[203,0,113,10]]);
            const received=new Promise<Buffer>(resolve=>udp.once("message",resolve));authorized.emit("frame",frame,1);
            expect(Array.from(await Promise.race([received,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("UDP timeout")),1500))]))).toEqual([7,8,9]);
        } finally {udp.close();}
    });
}
test("SR-01 an active private session closes when its invitation expires",async()=>{
    const port=await start();const token=new RoomAccess({},key).sign("locked",Math.floor(Date.now()/1000)+1);
    const c=client(port,"locked","websocket",token);const ready=event(c,"ready");c.connect();await ready;const closed=event(c,"disconnect");await closed;expect(c.connected).toBe(false);
});
