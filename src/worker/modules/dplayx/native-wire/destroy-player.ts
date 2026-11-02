/** Normal non-secure DP4 DESTROYPLAYERORG (cmd11).
 * NT5 dpmess.h / sysmess.c form; this encodes the inner system message.
 * Submission of this message is not an acknowledgement by the native host.
 */
export function encodeDirectPlay4DestroyPlayer(playerId:number,version:number):Uint8Array {
    if(!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||
        !Number.isInteger(version)||version<9||version>0xffff)
        throw new RangeError("invalid native player destruction");
    const bytes=new Uint8Array(28),view=new DataView(bytes.buffer);
    view.setUint32(0,0x79616c70,true);
    view.setUint16(4,11,true);
    view.setUint16(6,version,true);
    view.setUint32(12,playerId,true);
    return bytes;
}
