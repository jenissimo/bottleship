/**
 * DirectPlay 4 join messages without the size/token/SockAddr prefix ([MC-DPL4CS]):
 * 2.2.11 DPSP_MSG_ADDFORWARDREQUEST, 2.2.28 DPSP_MSG_ENUMPLAYERSREPLY (2.2.2
 * DPLAYI_PACKEDPLAYER entries) and 2.2.53 DPSP_MSG_SUPERENUMPLAYERSREPLY (2.2.3
 * DPLAYI_SUPERPACKEDPLAYER entries).
 * Local safety bounds are not a claim about native malformed-input policy.
 */
import {DPLAYI_PLAYER,DPSP_MSG,DPSP_SIGNATURE,DPSP_VERSION} from "./spec";

const u32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const copy = (input: Uint8Array): Uint8Array => Uint8Array.from(input);

/** 2.2.11 DPSP_MSG_ADDFORWARDREQUEST for a system player, using a caller-supplied 2.2.2
 * packed player: IDTo 0, PlayerID, GroupID 0, CreateOffset 28, PasswordOffset,
 * PlayerInfo, Password (UTF-16, NUL-terminated, possibly empty), TickCount. */
export function encodeDirectPlay4AddForward(
    playerId: number, packedPlayer: Uint8Array, password: string, tickCount: number, maxBytes: number,
    version: number = DPSP_VERSION.DX8,
): Uint8Array {
    if (!Number.isInteger(version) || version < 0 || version > 0xffff) throw new RangeError("invalid version");
    if (!u32(playerId) || !u32(tickCount)) throw new RangeError("IDs must be unsigned DWORDs");
    if (!(packedPlayer instanceof Uint8Array) || packedPlayer.length < 48)
        throw new RangeError("packed player is too short");
    if (typeof password !== "string" || password.includes("\0"))
        throw new RangeError("password must be a UTF-16 string without NUL");
    if (!Number.isInteger(maxBytes) || maxBytes < 82 || maxBytes > 0xfffff)
        throw new RangeError("invalid message limit");
    const packed = new DataView(packedPlayer.buffer, packedPlayer.byteOffset, packedPlayer.byteLength);
    if (packed.getUint32(0, true) !== packedPlayer.length ||
        packed.getUint32(8, true) !== playerId || packed.getUint32(36, true) < 48 ||
        packed.getUint32(36, true) > packedPlayer.length)
        throw new RangeError("invalid packed player extent or ID");
    const passwordBytes = (password.length + 1) * 2;
    const size = 28 + packedPlayer.length + passwordBytes + 4;
    if (size > maxBytes) throw new RangeError("message exceeds limit");
    const output = new Uint8Array(size), view = new DataView(output.buffer);
    view.setUint32(0, DPSP_SIGNATURE, true);
    view.setUint16(4, DPSP_MSG.ADDFORWARDREQUEST, true); view.setUint16(6, version, true);
    view.setUint32(12, playerId, true);
    view.setUint32(20, 28, true);
    const passwordOffset = 28 + packedPlayer.length;
    view.setUint32(24, passwordOffset, true);
    output.set(packedPlayer, 28);
    for (let i = 0; i < password.length; i++) view.setUint16(passwordOffset + i * 2, password.charCodeAt(i), true);
    view.setUint32(passwordOffset + passwordBytes, tickCount, true);
    return output;
}

export interface DirectPlay4PackedEntry {
    flags: number; id: number; fixedSize: number; versionOrSystemId: number; version: number;
    shortName: Uint8Array | null; longName: Uint8Array | null;
    playerData: Uint8Array; spData: Uint8Array; parentId: number;
    memberIds: number[];
    /** Full ordinary record (including any unknown fixed-size extension), if applicable. */
    ordinaryBytes?: Uint8Array;
}
export interface DirectPlay4Shortcut { flags: number; id: number; groupIds: number[]; }
export interface DirectPlay4NameTable {
    command: 3 | 41; version: number; sessionDescription: Uint8Array;
    name: Uint8Array | null; password: Uint8Array | null;
    players: DirectPlay4PackedEntry[]; groups: DirectPlay4PackedEntry[];
    shortcuts: DirectPlay4Shortcut[];
}

class Reader {
    readonly view: DataView;
    pos = 0;
    constructor(readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    range(pos: number, length: number): void {
        if (!Number.isInteger(pos) || !Number.isInteger(length) || pos < 0 || length < 0 ||
            pos > this.bytes.length || length > this.bytes.length - pos)
            throw new RangeError("truncated name table");
    }
    wordAt(pos: number): number { this.range(pos, 4); return this.view.getUint32(pos, true); }
    take(n: number): Uint8Array { this.range(this.pos, n); const a = copy(this.bytes.subarray(this.pos, this.pos+n)); this.pos += n; return a; }
    dword(): number { const v = this.wordAt(this.pos); this.pos += 4; return v; }
    sized(width: number): number {
        if (!width) return 0;
        const n = width === 3 ? 4 : width;
        this.range(this.pos,n);
        const value = n === 1 ? this.view.getUint8(this.pos) : n === 2 ? this.view.getUint16(this.pos,true) : this.view.getUint32(this.pos,true);
        this.pos += n; return value;
    }
    string(): Uint8Array {
        const start = this.pos;
        while (true) {
            this.range(this.pos, 2);
            const c = this.view.getUint16(this.pos, true); this.pos += 2;
            if (!c) return copy(this.bytes.subarray(start, this.pos));
        }
    }
    ids(count: number): number[] {
        if (count > Math.floor((this.bytes.length - this.pos) / 4)) throw new RangeError("too many IDs");
        const ids: number[] = [];
        for (let i=0; i<count; i++) ids.push(this.dword());
        return ids;
    }
}

function ordinary(r: Reader, group: boolean): DirectPlay4PackedEntry {
    const start = r.pos;
    r.range(start,48);
    const size=r.wordAt(start), flags=r.wordAt(start+4), id=r.wordAt(start+8);
    const shortLen=r.wordAt(start+12), longLen=r.wordAt(start+16), spLen=r.wordAt(start+20);
    const dataLen=r.wordAt(start+24), memberCount=r.wordAt(start+28), sys=r.wordAt(start+32);
    const fixed=r.wordAt(start+36), version=r.wordAt(start+40), parent=r.wordAt(start+44);
    if (fixed < 48 || size < fixed) throw new RangeError("invalid packed fixed size");
    r.range(start,size);
    const variable = shortLen + longLen + spLen + dataLen + (group ? memberCount * 4 : 0);
    if (variable > size-fixed || (!group && memberCount !== 0)) throw new RangeError("invalid packed fields");
    r.pos=start+fixed;
    const shortName=shortLen ? r.take(shortLen) : null, longName=longLen ? r.take(longLen) : null;
    const spData=r.take(spLen), playerData=r.take(dataLen), memberIds=group ? r.ids(memberCount) : [];
    r.pos=start+size;
    return {flags,id,fixedSize:fixed,versionOrSystemId:sys,version,shortName,longName,spData,playerData,
        parentId:parent,memberIds,ordinaryBytes:copy(r.bytes.subarray(start,start+size))};
}
/** Decode exactly one 2.2.2 DPLAYI_PACKEDPLAYER (player) record, with owned fields. */
export function decodeDirectPlay4PackedPlayer(input:Uint8Array,maxBytes:number):DirectPlay4PackedEntry {
    if(!(input instanceof Uint8Array)||!Number.isInteger(maxBytes)||maxBytes<48||maxBytes>0xfffff||
        input.length<48||input.length>maxBytes)throw new RangeError("invalid packed player extent");
    const reader=new Reader(input),result=ordinary(reader,false);
    if(reader.pos!==input.length)throw new RangeError("trailing packed player bytes");
    return result;
}
/** 2.2.3 PlayerInfoMask bits. Bits above SC SHOULD be zero when sent and MUST be ignored on receipt. */
const SPP = {SN:0x1, LN:0x2, SL_SHIFT:2, PD_SHIFT:4, PC_SHIFT:6, PI:0x100, SC_SHIFT:9} as const;

/**
 * One 2.2.3 DPLAYI_SUPERPACKEDPLAYER, fields in the order the spec lists them:
 * Size/Flags/ID/PlayerInfoMask (Size is the fixed header length), VersionOrSystemPlayerID,
 * ShortName, LongName, PlayerDataLength+PlayerData, ServiceProviderDataLength+Data,
 * PlayerCount+PlayerIDs, ParentID, ShortcutIDCount+ShortcutIDs.
 */
function superRecord(r: Reader) {
    const start=r.pos; r.range(start,16);
    const fixed=r.dword(), flags=r.dword(), id=r.dword(), mask=r.dword();
    if (fixed < 16) throw new RangeError("unsupported superpacked header");
    r.range(start,fixed); r.pos=start+fixed;
    const versionOrSystemId=r.dword();
    const shortName=(mask&SPP.SN) ? r.string() : null, longName=(mask&SPP.LN) ? r.string() : null;
    const playerData=r.take(r.sized((mask>>>SPP.PD_SHIFT)&3)), spData=r.take(r.sized((mask>>>SPP.SL_SHIFT)&3));
    const memberIds=r.ids(r.sized((mask>>>SPP.PC_SHIFT)&3));
    const parentId=(mask&SPP.PI) ? r.dword() : 0;
    const shortcutIds=r.ids(r.sized((mask>>>SPP.SC_SHIFT)&3));
    return {flags,id,fixed,mask,versionOrSystemId,shortName,longName,playerData,spData,memberIds,parentId,shortcutIds};
}
function superEntry(r: Reader, group: boolean): DirectPlay4PackedEntry {
    const e=superRecord(r);
    // Local policy: a player record carrying group-only fields is rejected rather than guessed at.
    if (!group && ((e.mask & SPP.PI) || ((e.mask>>>SPP.PC_SHIFT)&3) || ((e.mask>>>SPP.SC_SHIFT)&3)))
        throw new RangeError("group fields on player");
    return {flags:e.flags,id:e.id,fixedSize:e.fixed,versionOrSystemId:e.versionOrSystemId,
        version:(e.flags&DPLAYI_PLAYER.SYSPLAYER) ? e.versionOrSystemId : 0,shortName:e.shortName,longName:e.longName,
        playerData:e.playerData,spData:e.spData,parentId:e.parentId,memberIds:e.memberIds};
}
/** 2.2.53: the trailing ShortcutCount entries are superpacked groups whose ShortcutIDs list
 * the groups added to them with DPSP_MSG_ADDSHORTCUTTOGROUP. */
function shortcut(r: Reader): DirectPlay4Shortcut {
    const e=superRecord(r);
    return {flags:e.flags,id:e.id,groupIds:e.shortcutIds};
}

/** Decode one complete inner name-table reply; this never creates live players or groups. */
export function decodeDirectPlay4NameTable(input: Uint8Array, maxBytes: number, maxEntries: number): DirectPlay4NameTable {
    if (!(input instanceof Uint8Array)) throw new TypeError("input must be bytes");
    if (!Number.isInteger(maxBytes) || maxBytes < 116 || maxBytes > 0xfffff ||
        !Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > 4096)
        throw new RangeError("invalid limits");
    if (input.length < 116 || input.length > maxBytes) throw new RangeError("invalid name table size");
    const r=new Reader(input);
    if (r.wordAt(0)!==DPSP_SIGNATURE) throw new RangeError("invalid message signature");
    const cmd=r.view.getUint16(4,true), version=r.view.getUint16(6,true);
    if (cmd!==DPSP_MSG.ENUMPLAYERSREPLY && cmd!==DPSP_MSG.SUPERENUMPLAYERSREPLY) throw new RangeError("invalid name table command");
    const players=r.wordAt(8), groups=r.wordAt(12), packedOffset=r.wordAt(16);
    // 2.2.28: ShortcutCount of ENUMPLAYERSREPLY MUST be ignored on receipt.
    const shortcuts=cmd===DPSP_MSG.SUPERENUMPLAYERSREPLY ? r.wordAt(20) : 0;
    if (players+groups+shortcuts > maxEntries) throw new RangeError("too many name table records");
    const descOffset=r.wordAt(24), nameOffset=r.wordAt(28), passwordOffset=r.wordAt(32);
    if (descOffset<36) throw new RangeError("invalid session description offset");
    r.range(descOffset,80);
    if (packedOffset < descOffset+80 || packedOffset>input.length) throw new RangeError("invalid packed offset");
    const stringAt=(offset: number): Uint8Array | null => {
        if (!offset) return null;
        if (offset < descOffset+80 || offset>=packedOffset) throw new RangeError("invalid string offset");
        r.pos=offset; const value=r.string();
        if (r.pos>packedOffset) throw new RangeError("string crosses packed data");
        return value;
    };
    const name=stringAt(nameOffset), password=stringAt(passwordOffset);
    const sessionDescription=copy(input.subarray(descOffset,descOffset+80));
    r.pos=packedOffset;
    const playerEntries: DirectPlay4PackedEntry[]=[], groupEntries: DirectPlay4PackedEntry[]=[], shortcutEntries: DirectPlay4Shortcut[]=[];
    const plain=cmd===DPSP_MSG.ENUMPLAYERSREPLY;
    for(let i=0;i<players;i++) playerEntries.push(plain ? ordinary(r,false) : superEntry(r,false));
    for(let i=0;i<groups;i++) groupEntries.push(plain ? ordinary(r,true) : superEntry(r,true));
    for(let i=0;i<shortcuts;i++) shortcutEntries.push(shortcut(r));
    return {command:cmd,version,sessionDescription,name,password,players:playerEntries,groups:groupEntries,shortcuts:shortcutEntries};
}
