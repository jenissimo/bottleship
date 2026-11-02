import type {LanNetwork} from "../../../net/lan-network";
import {isExternalIpv4Node} from "../../../net/netplay-wire";
import type {WsaAddress,WsaSocketTable} from "../../wsa-network";
import type {Discovery} from "../session";
import type {DirectPlay4OwnedNameTable} from "./join-name-table-owner";
import {directPlay4HostSystemMatches} from "./host-system-authorization";
import type {DirectPlay4PlayerTcpFrame} from "./player-tcp";

/** A checked, revocable input for the isolated native Join driver. This does
 * not publish a product COM session or grant a gateway permission. */
export interface DirectPlay4NativeJoinPlan {
    readonly signal:AbortSignal;
    readonly udpListener:string;
    readonly destination:WsaAddress;
    readonly discovery:{version:number;flags:number;instanceGuid:Uint8Array;applicationGuid:Uint8Array;reserved1:number};
    current():boolean;
    authorizeDestination(address:WsaAddress):boolean;
    authorizePeer(address:WsaAddress):boolean;
    authorizeSystem(playerId:number,address:WsaAddress,systemPlayerId:number,table:DirectPlay4OwnedNameTable):boolean;
    authorizePlayer(frame:DirectPlay4PlayerTcpFrame,address:WsaAddress,table:DirectPlay4OwnedNameTable):boolean;
    close():void;
}
const validPort=(n:unknown):n is number=>typeof n==="number"&&Number.isInteger(n)&&n>0&&n<65536;
const uint=(n:unknown):n is number=>typeof n==="number"&&Number.isInteger(n)&&n>=0&&n<=0xffffffff;
const bytes=(s:string)=>Uint8Array.from(s.match(/../g)!,x=>parseInt(x,16));
const same=(a:Uint8Array|readonly number[],b:Uint8Array|readonly number[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);
function identity(found:Discovery):string {
    const d=found?.desc,provider=found?.nativeProvider,peer=provider?.peer,addr=found?.address;
    if(found?.native!==true||!d||!/^[a-f0-9]{32}$/.test(d.instance)||!/^[a-f0-9]{32}$/.test(d.application)||
        !uint(d.flags)||(d.flags&0x700)!==0||!Array.isArray(d.reserved)||!uint(d.reserved[0])||
        !provider||provider.version!==14||!(provider.sockaddr instanceof Uint8Array)||provider.sockaddr.length!==16||
        provider.sockaddr[0]!==2||provider.sockaddr[1]!==0||!peer||peer.family!==2||
        !(peer.node instanceof Uint8Array)||!isExternalIpv4Node(peer.node)||
        !(peer.ip instanceof Uint8Array)||peer.ip.length!==4||!same(peer.ip,peer.node.subarray(2))||!validPort(peer.port)||
        !addr||!Array.isArray(addr.node)||addr.node.length!==6||!addr.node.every(x=>Number.isInteger(x)&&x>=0&&x<=255)||
        !validPort(addr.port)||addr.port!==((provider.sockaddr[2]<<8)|provider.sockaddr[3]))
        throw new Error("native discovery identity unavailable");
    const ip=provider.sockaddr.subarray(4,8);
    if(ip.every(x=>x===0)||ip[0]>=224)throw new Error("native discovery address unavailable");
    return JSON.stringify([d.instance,d.application,d.flags,d.reserved[0],provider.version,[...provider.sockaddr],
        peer.family,[...peer.node],[...peer.ip],peer.port,addr.node,addr.port]);
}

export function createDirectPlay4NativeJoinPlan(network:LanNetwork,table:WsaSocketTable,found:Discovery,
    ownsDiscovery:()=>boolean, ownerSignal?:AbortSignal):DirectPlay4NativeJoinPlan {
    if(!network||!table||table.network!==network||typeof ownsDiscovery!=="function")
        throw new TypeError("invalid native join owner");
    const controller=new AbortController(),generation=table.generation;
    let retired=false,unsubscribe=()=>{};
    const close=()=>{if(retired)return;retired=true;unsubscribe();ownerSignal?.removeEventListener("abort",close);controller.abort();};
    ownerSignal?.addEventListener("abort",close,{once:true});
    if(ownerSignal?.aborted)close();
    // Any network epoch change retires this plan, even if settings later return
    // to the same values. Listener policy epochs cover reentrant replacements.
    unsubscribe=network.onStateChange(()=>close());
    try {
        if(retired){unsubscribe();throw new Error("native join owner retired");}
        const discoveryKey=identity(found);
        const provider=found.nativeProvider!,desc=found.desc,peer=provider.peer;
        const ip=Uint8Array.from(provider.sockaddr.subarray(4,8));
        const destination:WsaAddress={family:2,node:Uint8Array.from(found.address.node),ip,port:found.address.port};
        const dp4=network.directPlay4PolicySnapshot(),tcp=network.tcpHostPolicySnapshot(),udp=network.udpHostPolicySnapshot();
        const policy=dp4.policy;
        const tcpListener=tcp.capability?.listeners.find(x=>x.id===policy?.tcpHostListener);
        const udpListener=udp.capability?.listeners.find(x=>x.id===policy?.udpHostListener);
        const contains=(nodes:readonly (readonly number[])[]|undefined)=>!!nodes?.some(n=>same(n,peer.node));
        if(!dp4.connected||!tcp.connected||!udp.connected||!policy||policy.provider!=="native"||
            tcp.winsock?.provider!=="native"||tcp.winsock.hostListener!==policy.tcpHostListener||
            !tcpListener||!udpListener||!contains(tcpListener.allowedNodes)||!contains(udpListener.allowedNodes)||
            !network.hasGatewayIpv4(ip)||!same(network.routeIpv4(ip),destination.node)||!isExternalIpv4Node(destination.node)||
            !network.directPlay4PolicyEpochCurrent(dp4.epoch)||network.tcpHostPolicyCurrentEpoch!==tcp.epoch||
            !network.udpHostPolicyEpochCurrent(udp.epoch)||retired||controller.signal.aborted)
            throw new Error("native join route or listener unavailable");
        const captured={version:provider.version,flags:desc.flags,instanceGuid:bytes(desc.instance),
            applicationGuid:bytes(desc.application),reserved1:desc.reserved![0]};
        const current=()=>{
            if(retired||controller.signal.aborted)return false;
            let live=false;
            try {live=table.network===network&&table.generation===generation&&network.connected&&ownsDiscovery()&&
                identity(found)===discoveryKey&&network.directPlay4PolicyEpochCurrent(dp4.epoch)&&
                network.tcpHostPolicyCurrentEpoch===tcp.epoch&&network.udpHostPolicyEpochCurrent(udp.epoch)&&
                network.hasGatewayIpv4(ip)&&same(network.routeIpv4(ip),destination.node)&&ownsDiscovery()&&
                identity(found)===discoveryKey&&table.generation===generation&&
                network.directPlay4PolicyEpochCurrent(dp4.epoch)&&network.tcpHostPolicyCurrentEpoch===tcp.epoch&&
                network.udpHostPolicyEpochCurrent(udp.epoch)&&!retired&&!controller.signal.aborted;}
            catch {}
            if(!live)close();return live;
        };
        if(!current())throw new Error("native join owner retired");
        const authorizePeer=(address:WsaAddress)=>current()&&address?.family===2&&validPort(address.port)&&address.node instanceof Uint8Array&&
            same(address.node,peer.node)&&address.ip instanceof Uint8Array&&same(address.ip,peer.ip!)&&current();
        return {
            signal:controller.signal,udpListener:policy.udpHostListener,
            get destination(){return {...destination,node:Uint8Array.from(destination.node),ip:Uint8Array.from(ip)};},
            get discovery(){return {...captured,instanceGuid:Uint8Array.from(captured.instanceGuid),applicationGuid:Uint8Array.from(captured.applicationGuid)};},
            current,
            authorizeDestination(address){
                return current()&&address?.family===2&&validPort(address.port)&&address.port===destination.port&&
                    address.node instanceof Uint8Array&&same(address.node,destination.node)&&
                    address.ip instanceof Uint8Array&&same(address.ip,ip)&&current();
            },
            authorizePeer,
            authorizeSystem(playerId,address,systemPlayerId,roster){
                return uint(playerId)&&playerId>0&&playerId<0xfffffff0&&current()&&
                    directPlay4HostSystemMatches(roster,systemPlayerId)&&authorizePeer(address)&&current();
            },
            authorizePlayer(frame,address,roster){
                if(!frame||!uint(frame.from)||frame.from===0||frame.from>=0xfffffff0||!current())return false;
                const sender=roster?.players.find(p=>p.id===frame.from&&!(p.flags&1));
                return !!sender&&directPlay4HostSystemMatches(roster,sender.versionOrSystemId)&&authorizePeer(address)&&current();
            },
            close,
        };
    }catch(error){close();throw error;}
}
