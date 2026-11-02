import type {WsaAddress} from "../../wsa-network";
import type {DirectPlay4OwnedEntry,DirectPlay4OwnedNameTable} from "./join-name-table-owner";
import {decodeDirectPlay4CreatePlayer} from "./create-message";

/** Build a private replacement roster for one authorized remote player change.
 * The caller owns the atomic commit and must reject a reentrant replacement. */
export function applyDirectPlay4RemotePlayerMutation(
    table:DirectPlay4OwnedNameTable, bytes:Uint8Array, peer:WsaAddress,
    authorize:(playerId:number,peer:WsaAddress,systemPlayerId:number,table:DirectPlay4OwnedNameTable)=>boolean,
    current:()=>boolean, maxBytes=0x100000
):DirectPlay4OwnedNameTable {
    if(!table||!(bytes instanceof Uint8Array)||bytes.length<8||bytes.length>60008||
        !peer||peer.family!==2||!Number.isInteger(peer.port)||peer.port<1||peer.port>65535||
        !(peer.node instanceof Uint8Array)||peer.node.length!==6||peer.node[0]!==2||peer.node[1]!==1||
        !(peer.ip instanceof Uint8Array)||peer.ip.length!==4||!peer.ip.every((x,i)=>x===peer.node[i+2])||
        typeof authorize!=="function"||typeof current!=="function"||
        !Number.isInteger(maxBytes)||maxBytes<80||maxBytes>0x100000)
        throw new Error("invalid remote player mutation");
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(v.getUint32(0,true)!==0x79616c70||v.getUint16(6,true)!==table.version)
        throw new Error("invalid remote player protocol");
    const command=v.getUint16(4,true);
    let players:readonly DirectPlay4OwnedEntry[],id:number,systemId:number;
    if(command===8){
        const parsed=decodeDirectPlay4CreatePlayer(bytes,65536),entry=parsed.player;
        id=parsed.playerId;systemId=entry.versionOrSystemId;
        const system=table.players.find(p=>p.id===systemId);
        if(table.players.some(p=>p.id===id)||table.groups.some(g=>g.id===id)||
            table.players.length+table.groups.length+table.shortcuts.length>=4096||
            entry.flags!==8||entry.version!==table.version||entry.parentId!==0||entry.spData.length!==32||
            !system||!(system.flags&1)||system.preexisting)
            throw new Error("remote player create unavailable");
        const freeze=(data:Uint8Array|null)=>data===null?null:Object.freeze([...data]);
        const player:DirectPlay4OwnedEntry=Object.freeze({id,flags:entry.flags,fixedSize:entry.fixedSize,preexisting:false,
            versionOrSystemId:systemId,version:entry.version,parentId:entry.parentId,
            shortName:freeze(entry.shortName),longName:freeze(entry.longName),spData:freeze(entry.spData)!,
            playerData:freeze(entry.playerData)!,memberIds:Object.freeze([] as number[]),
            ...(entry.ordinaryBytes?{ordinaryBytes:freeze(entry.ordinaryBytes)!}:{})});
        players=Object.freeze([...table.players,player]);
    }else if(command===11&&bytes.length===28){
        id=v.getUint32(12,true);
        const target=table.players.find(p=>p.id===id);
        if(!target||target.preexisting||(target.flags&1)||table.groups.some(g=>g.memberIds.includes(id)))
            throw new Error("remote player delete unavailable");
        systemId=target.versionOrSystemId;
        players=Object.freeze(table.players.filter(p=>p.id!==id));
    }else throw new Error("remote player mutation unsupported");
    // Bound the entire replacement, including data retained from previous events.
    let size=table.sessionDescription.length+(table.name?.length??0)+(table.password?.length??0);
    for(const p of [...players,...table.groups]){
        size+=48+(p.shortName?.length??0)+(p.longName?.length??0)+p.spData.length+
            p.playerData.length+p.memberIds.length*4+(p.ordinaryBytes?.length??0);
    }
    for(const s of table.shortcuts)size+=16+s.groupIds.length*4;
    if(!Number.isSafeInteger(size)||size>maxBytes)throw new RangeError("remote player roster budget exceeded");
    const source:WsaAddress={family:peer.family,port:peer.port,node:Uint8Array.from(peer.node),ip:Uint8Array.from(peer.ip)};
    if(!current()||!authorize(id,source,systemId,table)||!current())throw new Error("remote player mutation unauthorized");
    const description=Uint8Array.from(table.sessionDescription);
    if(description.length!==80)throw new Error("invalid remote session description");
    new DataView(description.buffer).setUint32(44,players.filter(p=>!(p.flags&1)).length,true);
    return Object.freeze({...table,players,sessionDescription:Object.freeze([...description])});
}
