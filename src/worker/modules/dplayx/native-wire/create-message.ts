import {decodeDirectPlay4PackedPlayer,type DirectPlay4PackedEntry} from "./name-table";

/** Normal, nonsecure v14 CREATEPLAYER management message observed on Windows.
 * Other versions, password-bearing forward requests and group records are not
 * accepted by this decoder. The six-byte allocation suffix is opaque.
 */
export function decodeDirectPlay4CreatePlayer(input:Uint8Array,maxBytes:number):{version:number;playerId:number;player:DirectPlay4PackedEntry} {
    if(!(input instanceof Uint8Array)||!Number.isInteger(maxBytes)||maxBytes<76||maxBytes>65536||
        input.length<76||input.length>maxBytes)throw new RangeError("invalid create-player message");
    const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
    if(view.getUint32(0,true)!==0x79616c70||view.getUint16(4,true)!==8||view.getUint16(6,true)!==14||
        view.getUint32(20,true)!==28||view.getUint32(24,true)!==0)
        throw new RangeError("unsupported create-player header");
    const playerId=view.getUint32(12,true),size=view.getUint32(28,true);
    if(!playerId||size<48||size>input.length-28||![0,6].includes(input.length-28-size))
        throw new RangeError("invalid create-player extent");
    const player=decodeDirectPlay4PackedPlayer(input.subarray(28,28+size),maxBytes-28);
    if(player.id!==playerId)throw new RangeError("create-player identity mismatch");
    return {version:14,playerId,player};
}
