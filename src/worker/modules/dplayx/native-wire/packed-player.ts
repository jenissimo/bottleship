/**
 * Isolated legacy DirectPlay x86 PackPlayer and TCP/IP SPPLAYERDATA layout.
 * NT5 dplaypr.h:679-703, dplaysp.h:209-230, pack.c:393-415,450-553;
 * wsock/dpsp.h:293-297, wsock/winsock.c:600-674. The address bytes are
 * supplied by the caller: this module does not acquire or authorize sockets.
 */
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const nonPropFlags = 0x17000;

/** Raw Win32 sockaddr bytes, stream first then datagram; caller owns semantics. */
export function encodeDirectPlay4TcpIpPlayerData(stream: Uint8Array, datagram: Uint8Array): Uint8Array {
    if (!(stream instanceof Uint8Array) || stream.length !== 16 ||
        !(datagram instanceof Uint8Array) || datagram.length !== 16)
        throw new RangeError("each provider address must contain 16 raw bytes");
    const result = new Uint8Array(32);
    result.set(stream); result.set(datagram,16);
    return result;
}

export interface DirectPlay4PlayerForPacking {
    flags: number; id: number; systemPlayerId: number; version: number; parentId: number;
    /** null means no string; an empty string emits a UTF-16 NUL. */
    shortName: string | null; longName: string | null;
    spData: Uint8Array; playerData: Uint8Array;
}

/** Player-only source layout; fields, bytes and maxBytes are explicit caller inputs. */
export function encodeDirectPlay4PackedPlayer(player: DirectPlay4PlayerForPacking, maxBytes: number): Uint8Array {
    if (!Number.isInteger(maxBytes) || maxBytes < 48 || maxBytes > 0xfffff)
        throw new RangeError("invalid packed-player limit");
    if (!player || !uint(player.flags) || !uint(player.id) || !uint(player.systemPlayerId) ||
        !uint(player.version) || !uint(player.parentId))
        throw new RangeError("player values must be unsigned DWORDs");
    const strLength = (s: string | null): number => {
        if (s === null) return 0;
        if (typeof s !== "string" || s.includes("\0")) throw new RangeError("invalid UTF-16 name");
        return (s.length + 1) * 2;
    };
    const shortLength=strLength(player.shortName), longLength=strLength(player.longName);
    if (!(player.spData instanceof Uint8Array) || !(player.playerData instanceof Uint8Array))
        throw new TypeError("player data must be bytes");
    const size=48+shortLength+longLength+player.spData.length+player.playerData.length;
    if (size > maxBytes) throw new RangeError("packed player exceeds limit");
    const result=new Uint8Array(size), view=new DataView(result.buffer);
    view.setUint32(0,size,true);
    view.setUint32(4,(player.flags & ~nonPropFlags) >>> 0,true);
    view.setUint32(8,player.id,true);
    view.setUint32(12,shortLength,true); view.setUint32(16,longLength,true);
    view.setUint32(20,player.spData.length,true); view.setUint32(24,player.playerData.length,true);
    view.setUint32(32,player.systemPlayerId,true); view.setUint32(36,48,true);
    view.setUint32(40,player.version,true); view.setUint32(44,player.parentId,true);
    let offset=48;
    for (const name of [player.shortName,player.longName]) {
        if (name === null) continue;
        for (let i=0;i<name.length;i++) view.setUint16(offset+i*2,name.charCodeAt(i),true);
        offset += (name.length+1)*2;
    }
    result.set(player.spData,offset); offset+=player.spData.length;
    result.set(player.playerData,offset);
    return result;
}
