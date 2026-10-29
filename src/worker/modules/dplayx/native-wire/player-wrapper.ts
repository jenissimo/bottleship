import {decodeDirectPlay4SystemTcpFrame,encodeDirectPlay4SystemTcpFrame} from "./tcp-frame";
import type {DirectPlay4PlayerTcpFrame} from "./player-tcp";

/** NT5 sysmess.c:1528–1563,1756–1763; dpmess.h DPSP_MSG_PLAYERWRAPPER=25.
 * Only nonsecure sessions with message IDs are supported here; provider
 * routing, NOMESSAGEID and version negotiation are caller responsibilities. */
export function encodeDirectPlay4PlayerWrapper(
    provider:Uint8Array, from:number, to:number, data:Uint8Array, version:number, maxBytes:number,
):Uint8Array {
    const uint=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
    if(!uint(from)||!uint(to)||!Number.isInteger(version)||version<0||version>0xffff||
        !(data instanceof Uint8Array))throw new RangeError("invalid wrapped player message");
    // Reject before allocating an unbounded copy.
    if(!Number.isInteger(maxBytes)||maxBytes<36||maxBytes>0xfffff||data.length>maxBytes-36)
        throw new RangeError("wrapped player message exceeds limit");
    const inner=new Uint8Array(16+data.length),view=new DataView(inner.buffer);
    view.setUint32(0,0x79616c70,true);view.setUint16(4,25,true);view.setUint16(6,version,true);
    view.setUint32(8,from,true);view.setUint32(12,to,true);inner.set(data,16);
    return encodeDirectPlay4SystemTcpFrame(provider,inner,maxBytes);
}

/** Decode one complete wrapper; returned address and payload are owned copies. */
export function decodeDirectPlay4PlayerWrapper(input:Uint8Array,maxBytes:number): (DirectPlay4PlayerTcpFrame & {version:number}) | null {
    const outer=decodeDirectPlay4SystemTcpFrame(input,maxBytes);
    if(!outer)return null;
    if(outer.command!==25||outer.message.length<16)throw new RangeError("not a complete player wrapper");
    const view=new DataView(outer.message.buffer,outer.message.byteOffset,outer.message.byteLength);
    return {consumed:outer.consumed,providerSockaddr:outer.providerSockaddr,
        from:view.getUint32(8,true),to:view.getUint32(12,true),
        data:Uint8Array.from(outer.message.subarray(16)),version:outer.version};
}
