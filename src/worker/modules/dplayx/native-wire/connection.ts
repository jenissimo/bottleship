import {isExternalIpv4Node} from "../../../net/netplay-wire";
import type {LanNetwork} from "../../../net/lan-network";
import type {WsaAddress} from "../../wsa-network";
import {DPSP_SERVER_PORT} from "./spec";

/** DPAID_INet {C4A54DA0-E0AF-11CF-9C4E-00A0C905425E} (DirectX SDK dplobby.h), raw GUID bytes. */
const INET = "a04da5c4afe0cf119c4e00a0c905425e";
/** DPAID_INetPort {E4524541-8EA5-11D1-8A96-006097B01411} (dplobby.h), raw GUID bytes. */
const INET_PORT = "414552e4a58ed1118a96006097b01411";
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2,"0")).join("");
/** [MC-DPL4CS] 2.1: enumeration messages go to the host on port 47624.
 * Walks the DPADDRESS chunks (DirectPlay Address docs, DPCOMPOUNDADDRESSELEMENT);
 * explicit numeric DPAID_INet only; DNS and broadcast are not yet wired. */
export function nativeEnumDestination(bytes: Uint8Array, network: LanNetwork): WsaAddress | undefined {
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let offset=0, count=0, address: Uint8Array | undefined;
    while(offset < bytes.length && ++count <= 64) {
        if(bytes.length-offset<20) break;
        const size=view.getUint32(offset+16,true);
        if(size>bytes.length-offset-20) break;
        if(hex(bytes.subarray(offset,offset+16))===INET) {
            const data=bytes.subarray(offset+20,offset+20+size), end=data.indexOf(0);
            if(end < 0 || end > 15) return undefined;
            const text=String.fromCharCode(...data.subarray(0,end));
            const parts=text.split(".");
            if(parts.length!==4 || parts.some(part=>!/^\d{1,3}$/.test(part) || Number(part)>255)) return undefined;
            address=Uint8Array.from(parts.map(Number));
        }
        offset+=20+size;
    }
    if(!address) return undefined;
    const node=network.routeIpv4(address);
    if(!isExternalIpv4Node(node)) return undefined;
    return {family:2,node,ip:address,port:DPSP_SERVER_PORT};
}

/** DPAID_INetPort (a WORD, per the DirectPlay Address docs) selects the host port for
 * the TCP enumeration; the last such chunk wins, and absent or zero uses the
 * [MC-DPL4CS] 2.1 enumeration port 47624. */
export function nativeEnumTcpPort(bytes: Uint8Array): number | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0, count = 0, port = 0;
    while (offset < bytes.length && ++count <= 64) {
        if (bytes.length - offset < 20) break;
        const size = view.getUint32(offset + 16, true);
        if (size > bytes.length - offset - 20) break;
        if (hex(bytes.subarray(offset, offset + 16)) === INET_PORT) {
            if (size < 2) return undefined;
            port = view.getUint16(offset + 20, true);
        }
        offset += 20 + size;
    }
    return port || DPSP_SERVER_PORT;
}
