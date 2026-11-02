import {isExternalIpv4Node} from "../../../net/netplay-wire";
import type {LanNetwork} from "../../../net/lan-network";
import type {WsaAddress} from "../../wsa-network";

const INET = "a04da5c4afe0cf119c4e00a0c905425e";
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2,"0")).join("");
/** Source wsock/winsock.c:1157-1188: UDP discovery uses SERVER_DGRAM_PORT.
 * Explicit numeric INET only; DNS and broadcast are not yet wired. */
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
    return {family:2,node,ip:address,port:47624};
}

/** wsock/dpsp.c:2093-2106,4632-4635: last INetPort WORD selects
 * TCP destination; absent or zero uses SERVER_STREAM_PORT 47624. */
export function nativeEnumTcpPort(bytes: Uint8Array): number | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0, count = 0, port = 0;
    while (offset < bytes.length && ++count <= 64) {
        if (bytes.length - offset < 20) break;
        const size = view.getUint32(offset + 16, true);
        if (size > bytes.length - offset - 20) break;
        if (hex(bytes.subarray(offset, offset + 16)) === "414552e4a58ed1118a96006097b01411") {
            if (size < 2) return undefined;
            port = view.getUint16(offset + 20, true);
        }
        offset += 20 + size;
    }
    return port || 47624;
}
