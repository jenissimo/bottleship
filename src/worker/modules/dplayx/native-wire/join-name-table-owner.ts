import type {DirectPlay4NameTable,DirectPlay4PackedEntry} from "./name-table";

/**
 * Staged native name-table data, without a virtual Session mutation.
 * Input must be the plain data returned by decodeDirectPlay4NameTable, not
 * arbitrary objects with accessors or proxies; this is not a JS object sandbox.
 * NT5 superpac.c:319-323, 341-378, 390-419, 446-495:
 * players, groups, then subgroup shortcuts; a local system player may
 * already exist. Native continues after some failed links. Duplicate/dangling
 * rejection below is our local fail-closed policy, not a native oracle.
 * Byte budget measures source bytes, not JS heap: frozen number arrays have
 * per-element overhead. A 1 MiB hard cap and 4096 entries bound amplification.
 */
export interface DirectPlay4OwnedEntry {
    readonly id:number; readonly flags:number; readonly fixedSize:number;
    /** Existing local system player; reuse its identity rather than recreate it. */
    readonly preexisting:boolean;
    readonly versionOrSystemId:number; readonly version:number; readonly parentId:number;
    readonly shortName:readonly number[]|null; readonly longName:readonly number[]|null;
    readonly spData:readonly number[]; readonly playerData:readonly number[];
    readonly memberIds:readonly number[]; readonly ordinaryBytes?:readonly number[];
}
export interface DirectPlay4OwnedNameTable {
    readonly command:3|41; readonly version:number; readonly sessionDescription:readonly number[];
    readonly name:readonly number[]|null; readonly password:readonly number[]|null;
    readonly players:readonly DirectPlay4OwnedEntry[]; readonly groups:readonly DirectPlay4OwnedEntry[];
    readonly shortcuts:readonly {readonly id:number;readonly flags:number;readonly groupIds:readonly number[]}[];
}
const uint=(n:unknown):n is number=>typeof n==="number"&&Number.isInteger(n)&&n>=0&&n<=0xffffffff;
export class DirectPlay4JoinNameTableOwner {
    private state:"staged"|"transferred"|"retired"="staged";
    private snapshot?:DirectPlay4OwnedNameTable;
    constructor(table:DirectPlay4NameTable,existingPlayerIds:readonly number[],
        maxEntries:number,maxBytes:number,private readonly owns:()=>boolean) {
        if(!table || !Array.isArray(table.players)||!Array.isArray(table.groups)||!Array.isArray(table.shortcuts)||
            !Array.isArray(existingPlayerIds)||!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>4096||
            !Number.isInteger(maxBytes)||maxBytes<80||maxBytes>0x100000||typeof owns!=="function"||
            (table.command!==3&&table.command!==41)||!uint(table.version)||table.version>0xffff)
            throw new RangeError("invalid name-table owner inputs");
        const playerCount=table.players.length,groupCount=table.groups.length,shortcutCount=table.shortcuts.length,existingCount=existingPlayerIds.length;
        if(![playerCount,groupCount,shortcutCount,existingCount].every(n=>Number.isInteger(n)&&n>=0&&n<=maxEntries) ||
            playerCount+groupCount+shortcutCount+existingCount>maxEntries)
            throw new RangeError("name-table entry budget exceeded");
        let bytes=0;
        const charge=(n:number)=>{if(!Number.isSafeInteger(n)||n<0||n>maxBytes-bytes)throw new RangeError("name-table byte budget exceeded");bytes+=n;};
        const copy=(b:Uint8Array|null):readonly number[]|null=>{
            if(b===null)return null;
            if(!(b instanceof Uint8Array))throw new TypeError("expected bytes");
            const length=b.length;charge(length);const result:number[]=[];
            for(let i=0;i<length;i++)result.push(b[i]);
            return Object.freeze(result);
        };
        const dense=<T>(a:readonly T[],length:number):T[]=>{
            const out:T[]=[];
            for(let i=0;i<length;i++){
                if(!Object.prototype.hasOwnProperty.call(a,i))throw new TypeError("sparse array");
                out.push(a[i]);
            }
            return out;
        };
        const ids=(a:readonly number[]):readonly number[]=>{
            if(!Array.isArray(a))throw new TypeError("invalid IDs");
            const length=a.length;charge(length*4);
            const values=dense(a,length);
            if(!values.every(uint))throw new TypeError("invalid IDs");
            return Object.freeze(values);
        };
        const all=new Set<number>(), players=new Set<number>(), groups=new Set<number>(), existing=new Set<number>(), wire=new Set<number>();
        for(const id of dense(existingPlayerIds,existingCount)){if(!uint(id)||all.has(id))throw new RangeError("invalid existing player identity");all.add(id);players.add(id);existing.add(id);}
        const entry=(v:DirectPlay4PackedEntry,group:boolean):DirectPlay4OwnedEntry=>{
            if(!v||![v.id,v.flags,v.fixedSize,v.versionOrSystemId,v.version,v.parentId].every(uint)||wire.has(v.id))
                throw new RangeError("duplicate or invalid identity");
            // Existing IDs are explicitly local system players. Only a system
            // player record can refer to one (dplaysp.h:134, flag 0x1).
            const preexisting=!group&&existing.has(v.id);
            if((all.has(v.id)&&!preexisting)||(preexisting&&!(v.flags&1)))throw new RangeError("identity collision");
            wire.add(v.id);
            if(!(v.spData instanceof Uint8Array)||!(v.playerData instanceof Uint8Array))throw new TypeError("invalid player data");
            all.add(v.id);(group?groups:players).add(v.id);charge(48);
            const memberIds=ids(v.memberIds);
            if(!group&&memberIds.length)throw new RangeError("player has group members");
            return Object.freeze({id:v.id,flags:v.flags,fixedSize:v.fixedSize,preexisting,versionOrSystemId:v.versionOrSystemId,
                version:v.version,parentId:v.parentId,shortName:copy(v.shortName),longName:copy(v.longName),
                spData:copy(v.spData)!,playerData:copy(v.playerData)!,memberIds,
                ...(v.ordinaryBytes?{ordinaryBytes:copy(v.ordinaryBytes)!}:{})});
        };
        const p=dense(table.players,playerCount).map(x=>entry(x,false)),g=dense(table.groups,groupCount).map(x=>entry(x,true));
        for(const x of g){
            if(x.parentId!==0&&!groups.has(x.parentId))throw new RangeError("unresolved parent group");
            const seen=new Set<number>();
            for(const id of x.memberIds){if(!players.has(id)||seen.has(id))throw new RangeError("unresolved or duplicate member");seen.add(id);}
        }
        const shortcuts=dense(table.shortcuts,shortcutCount).map(x=>{
            if(!x||!uint(x.id)||!uint(x.flags)||!groups.has(x.id))throw new RangeError("unresolved shortcut group");
            charge(16);const groupIds=ids(x.groupIds),seen=new Set<number>();
            for(const id of groupIds){if(!groups.has(id)||seen.has(id))throw new RangeError("unresolved or duplicate shortcut");seen.add(id);}
            return Object.freeze({id:x.id,flags:x.flags,groupIds});
        });
        const desc=copy(table.sessionDescription);
        if(!desc||desc.length!==80)throw new RangeError("invalid session description");
        this.snapshot=Object.freeze({command:table.command,version:table.version,sessionDescription:desc,
            name:copy(table.name),password:copy(table.password),players:Object.freeze(p),groups:Object.freeze(g),
            shortcuts:Object.freeze(shortcuts)});
    }
    /** One-way transfer only; caller must independently fence/install the returned snapshot. */
    commit():DirectPlay4OwnedNameTable|undefined {
        if(this.state!=="staged")return;
        let current=false;try{current=this.owns();}catch{}
        if(!current){this.retire();return;}
        if(this.state!=="staged")return;
        const result=this.snapshot;this.snapshot=undefined;this.state="transferred";return result;
    }
    retire():void {if(this.state==="staged"){this.state="retired";this.snapshot=undefined;}}
}
