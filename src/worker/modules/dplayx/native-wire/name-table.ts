/**
 * Isolated x86 legacy DirectPlay Join messages, without SP framing.
 * NT5 dpmess.h:221-235,261-280, dplaypr.h:670-703,
 * sysmess.c:1223-1340, handler.c:710-845, pack.c:345-386,450-551,
 * superpac.c:48-55,133-226,341-382,390-495,650-814.
 * Local safety bounds are not a claim about native malformed-input policy.
 */
const u32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const copy = (input: Uint8Array): Uint8Array => Uint8Array.from(input);

/** Encode a forwarded system player using a caller-supplied PackPlayer blob. */
export function encodeDirectPlay4AddForward(
    playerId: number, packedPlayer: Uint8Array, password: string, tickCount: number, maxBytes: number, version = 13,
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
    view.setUint32(0, 0x79616c70, true);
    view.setUint16(4, 19, true); view.setUint16(6, version, true);
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
function superEntry(r: Reader, group: boolean): DirectPlay4PackedEntry {
    const start=r.pos; r.range(start,16);
    const fixed=r.dword(), flags=r.dword(), id=r.dword(), mask=r.dword();
    if (fixed < 16 || (mask & ~0x7ff) !== 0) throw new RangeError("unsupported superpacked header");
    r.range(start,fixed); r.pos=start+fixed;
    const versionOrSystemId=r.dword();
    const shortName=(mask&1) ? r.string() : null, longName=(mask&2) ? r.string() : null;
    const playerData=r.take(r.sized((mask>>>4)&3)), spData=r.take(r.sized((mask>>>2)&3));
    if (!group && (mask & (0x100 | 0xc0))) throw new RangeError("group fields on player");
    const parentId=(mask&0x100) ? r.dword() : 0;
    const memberIds=group ? r.ids(r.sized((mask>>>6)&3)) : [];
    return {flags,id,fixedSize:fixed,versionOrSystemId,version:(flags&1) ? versionOrSystemId : 0,shortName,longName,playerData,spData,parentId,memberIds};
}
function shortcut(r: Reader): DirectPlay4Shortcut {
    const start=r.pos; r.range(start,16);
    const fixed=r.dword(), flags=r.dword(), id=r.dword(), mask=r.dword();
    // NT5 reads only bits 9..10; other bits may contain allocator garbage.
    // Those two width bits themselves must still describe the encoded count.
    if (fixed < 16) throw new RangeError("unsupported shortcut header");
    r.range(start,fixed); r.pos=start+fixed;
    return {flags,id,groupIds:r.ids(r.sized((mask>>>9)&3))};
}

/** Decode one complete inner name-table reply; this never creates live players or groups. */
export function decodeDirectPlay4NameTable(input: Uint8Array, maxBytes: number, maxEntries: number): DirectPlay4NameTable {
    if (!(input instanceof Uint8Array)) throw new TypeError("input must be bytes");
    if (!Number.isInteger(maxBytes) || maxBytes < 116 || maxBytes > 0xfffff ||
        !Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > 4096)
        throw new RangeError("invalid limits");
    if (input.length < 116 || input.length > maxBytes) throw new RangeError("invalid name table size");
    const r=new Reader(input);
    if (r.wordAt(0)!==0x79616c70) throw new RangeError("invalid message signature");
    const cmd=r.view.getUint16(4,true), version=r.view.getUint16(6,true);
    if (cmd!==3 && cmd!==41) throw new RangeError("invalid name table command");
    const players=r.wordAt(8), groups=r.wordAt(12), packedOffset=r.wordAt(16);
    const shortcuts=cmd===41 ? r.wordAt(20) : 0;
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
    for(let i=0;i<players;i++) playerEntries.push(cmd===3 ? ordinary(r,false) : superEntry(r,false));
    for(let i=0;i<groups;i++) groupEntries.push(cmd===3 ? ordinary(r,true) : superEntry(r,true));
    for(let i=0;i<shortcuts;i++) shortcutEntries.push(shortcut(r));
    return {command:cmd,version,sessionDescription,name,password,players:playerEntries,groups:groupEntries,shortcuts:shortcutEntries};
}
