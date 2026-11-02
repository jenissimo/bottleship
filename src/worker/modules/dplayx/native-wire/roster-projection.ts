import type {DirectPlay4OwnedNameTable} from "./join-name-table-owner";
import type {DirectPlay4NativeRosterChange} from "./native-session";
import type {DirectPlaySession,Entity,SystemMessage} from "../session";

/** Guest-facing values for the independently observed normal remote-player case.
 * This is a staged projection; it does not publish a COM session. */
export interface DirectPlay4RemotePlayerProjection {
    readonly id:number;
    readonly systemPlayerId:number;
    readonly flags:0;
    readonly shortName:string;
    readonly longName:string;
    readonly shortNull:boolean;
    readonly longNull:boolean;
    readonly data:readonly number[];
}

function name(bytes:readonly number[]|null):string {
    if(bytes===null)return "";
    if(bytes.length<2||bytes.length>2050||(bytes.length&1))throw new RangeError("invalid native player name");
    let text="";
    for(let i=0;i<bytes.length;i+=2){
        const a=bytes[i],b=bytes[i+1];
        if(!Number.isInteger(a)||a<0||a>255||!Number.isInteger(b)||b<0||b>255)
            throw new RangeError("invalid native player name");
        const code=a|(b<<8);
        if(!code){
            if(i!==bytes.length-2)throw new RangeError("trailing native player name bytes");
            return text;
        }
        text+=String.fromCharCode(code);
    }
    throw new RangeError("unterminated native player name");
}

export function projectDirectPlay4RemotePlayers(table:DirectPlay4OwnedNameTable):readonly DirectPlay4RemotePlayerProjection[] {
    if(!table||table.version!==14||table.groups.length||table.shortcuts.length)
        throw new Error("native roster projection unsupported");
    const systems=new Map(table.players.filter(p=>(p.flags&1)!==0).map(p=>[p.id,p]));
    const seen=new Set<number>(),result:DirectPlay4RemotePlayerProjection[]=[];
    for(const player of table.players){
        if(player.flags&1)continue;
        if((player.flags!==8&&player.flags!==12)||!Number.isInteger(player.id)||player.id<1||player.id>=0xfffffff0||
            seen.has(player.id)||player.parentId!==0||player.memberIds.length||player.playerData.length>60000)
            throw new Error("native player projection unsupported");
        const system=systems.get(player.versionOrSystemId);
        if(!system||system.preexisting)throw new Error("native player owner unavailable");
        seen.add(player.id);
        result.push(Object.freeze({id:player.id,systemPlayerId:player.versionOrSystemId,flags:0 as const,
            shortName:name(player.shortName),longName:name(player.longName),shortNull:player.shortName===null,
            longNull:player.longName===null,data:Object.freeze([...player.playerData])}));
    }
    return Object.freeze(result);
}

/** Stage the independently observed create/destroy player notification.
 * Guest queue ownership, recipient selection and packing belong to the COM adapter. */
export function projectDirectPlay4RosterChange(change:DirectPlay4NativeRosterChange):
    {readonly type:3|5;readonly player:DirectPlay4RemotePlayerProjection} {
    if(!change||(change.kind!=="create"&&change.kind!=="delete"))throw new Error("invalid native roster change");
    const before=projectDirectPlay4RemotePlayers(change.before),after=projectDirectPlay4RemotePlayers(change.after);
    const previous=before.find(p=>p.id===change.playerId),next=after.find(p=>p.id===change.playerId);
    if(change.kind==="create"?(!!previous||!next||after.length!==before.length+1):(!previous||!!next||before.length!==after.length+1))
        throw new Error("invalid native roster transition");
    const unchangedBefore=before.filter(p=>p.id!==change.playerId),unchangedAfter=after.filter(p=>p.id!==change.playerId);
    if(JSON.stringify(unchangedBefore)!==JSON.stringify(unchangedAfter))throw new Error("unrelated native roster mutation");
    return Object.freeze({type:change.kind==="create"?3:5,player:(next??previous)!});
}

/** Build detached guest values. The session still owns queueing and events. */
export function directPlay4GuestEntity(player:DirectPlay4RemotePlayerProjection):Entity {
    return {id:player.id,group:false,owner:"native:"+player.systemPlayerId,flags:player.flags,
        name:{short:player.shortName,long:player.longName,shortNull:player.shortNull,longNull:player.longNull},
        data:[...player.data],members:[],parent:0,groupOwner:0};
}
const installing=new WeakSet<DirectPlaySession>();
/** Publish a complete checked projection in one synchronous turn, with no
 * callbacks or guest-visible partial roster between individual insertions. */
export function installDirectPlay4GuestRoster(session:DirectPlaySession,table:DirectPlay4OwnedNameTable,owns:()=>boolean):void {
    if(!session||typeof owns!=="function"||installing.has(session))throw new Error("native roster owner unavailable");
    installing.add(session);
    try {
        const description=session.desc,entities=session.entities,ownKey=session.ownKey;
        const previous=[...entities.entries()];
        const staged=projectDirectPlay4RemotePlayers(table).map(directPlay4GuestEntity);
        if(session.version!==4||!description||session.openError||previous.length+staged.length>128)
            throw new Error("native roster session unavailable");
        const ids=new Set(previous.map(([id])=>id));
        let bytes=0;
        for(const [,entity] of previous)bytes+=entity.data.length+2*(entity.name.short.length+entity.name.long.length);
        if(bytes>0x100000)throw new Error("native roster too large");
        for(const entity of staged){
            if(ids.has(entity.id))throw new Error("native roster player collision");
            ids.add(entity.id);bytes+=entity.data.length+2*(entity.name.short.length+entity.name.long.length);
            if(bytes>0x100000)throw new Error("native roster too large");
        }
        const current=()=>session.desc===description&&!session.openError&&session.entities===entities&&session.ownKey===ownKey&&
            entities.size===previous.length&&previous.every(([id,entity])=>entities.get(id)===entity);
        if(!current()||!owns()||!current()||!owns()||!current())throw new Error("native roster owner retired");
        for(const entity of staged)Map.prototype.set.call(entities,entity.id,entity);
    } finally {installing.delete(session);}
}
export function directPlay4GuestNotification(change:DirectPlay4NativeRosterChange):SystemMessage {
    const projected=projectDirectPlay4RosterChange(change);
    const description=Uint8Array.from(change.after.sessionDescription);
    if(description.length!==80)throw new Error("invalid native session description");
    const currentPlayers=new DataView(description.buffer).getUint32(44,true);
    return {type:projected.type,entity:directPlay4GuestEntity(projected.player),currentPlayers};
}
