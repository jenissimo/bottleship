/**
 * [MC-DPL4CS] 2.2.2 DPLAYI_PACKEDPLAYER for a player (not a group), and the
 * Winsock service provider's ServiceProviderData described there: a stream
 * SOCKADDR_IN followed by a datagram SOCKADDR_IN (2.2.1). The address bytes
 * are supplied by the caller: this module does not acquire or authorize sockets.
 */
import {DPLAYI_PLAYER_DEFINED_FLAGS} from "./spec";

const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/** 2.2.2 ServiceProviderData: stream then datagram SOCKADDR_IN, raw 16 bytes each. */
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

/** Player-only DPLAYI_PACKEDPLAYER (NumberOfPlayers 0, no PlayerIDs); fields, bytes and
 * maxBytes are explicit caller inputs. Name lengths include the UTF-16 terminator. */
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
    // 2.2.2 Flags: only SP/NS/PG/PL are defined; other bits SHOULD be zero when sent.
    view.setUint32(4,(player.flags & DPLAYI_PLAYER_DEFINED_FLAGS) >>> 0,true);
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
