import {DPSP_MSG,DPSP_SIGNATURE,DPSP_VERSION} from "./spec";

/** [MC-DPL4CS] 2.2.25 DPSP_MSG_DELETEPLAYER (0x0B), nonsecure, inner message only:
 * IDTo, GroupID, CreateOffset and PasswordOffset are zero; PlayerID at +12.
 * Submission of this message is not an acknowledgement by the native host.
 */
export function encodeDirectPlay4DestroyPlayer(playerId:number,version:number):Uint8Array {
    if(!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||
        !Number.isInteger(version)||version<DPSP_VERSION.DX6||version>0xffff)
        throw new RangeError("invalid native player destruction");
    const bytes=new Uint8Array(28),view=new DataView(bytes.buffer);
    view.setUint32(0,DPSP_SIGNATURE,true);
    view.setUint16(4,DPSP_MSG.DELETEPLAYER,true);
    view.setUint16(6,version,true);
    view.setUint32(12,playerId,true);
    return bytes;
}
