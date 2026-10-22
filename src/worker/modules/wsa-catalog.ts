/** Win32 WSAPROTOCOL_INFO records for the implemented BottleShip providers. */
export interface WsaProtocol { family: number; type: number; protocol: number; name: string; catalogId: number; }
export const wsaProtocols: readonly WsaProtocol[] = [
    { family: 2, type: 1, protocol: 6, name: "BottleShip TCP/IPv4", catalogId: 1 },
    { family: 2, type: 2, protocol: 17, name: "BottleShip UDP/IPv4", catalogId: 2 },
    { family: 6, type: 2, protocol: 1000, name: "BottleShip IPX", catalogId: 3 },
    { family: 23, type: 1, protocol: 6, name: "BottleShip TCP/IPv6", catalogId: 4 },
    { family: 23, type: 2, protocol: 17, name: "BottleShip UDP/IPv6", catalogId: 5 },
    { family: 2, type: 3, protocol: 0, name: "BottleShip RAW/IPv4", catalogId: 6 },
    { family: 23, type: 3, protocol: 0, name: "BottleShip RAW/IPv6", catalogId: 7 },
];
export function protocolInfoSize(wide: boolean): number { return 116 + (wide ? 512 : 256); }
export function protocolInfo(entry: WsaProtocol, wide: boolean): Uint8Array {
    const output = new Uint8Array(protocolInfoSize(wide)), view = new DataView(output.buffer);
    // Service flags describe actual transport properties. Handles are provider-owned, not IFS handles.
    view.setUint32(0, entry.type === 1 ? 2 | 4 | 64 | 128 : 1 | 8 | (entry.family === 23 ? 0 : 512), true);
    // Stable private provider GUID and catalog ID; no dependency on a host's installed providers.
    output.set([0x4d, 0x51, 0x8f, 0x8c, 0x53, 0x42, 0x4c, 0x41, 0x92, 0x4e, 0x42, 0x53, 0x4c, 0x41, 0x4e, entry.family], 20);
    view.setUint32(36, entry.catalogId, true); view.setUint32(40, 1, true);
    view.setUint32(72, 2, true); view.setUint32(76, entry.family, true);
    view.setUint32(80, entry.family === 6 ? 16 : entry.family === 23 ? 28 : 16, true);
    view.setUint32(84, entry.family === 6 ? 14 : entry.family === 23 ? 28 : 16, true);
    view.setUint32(88, entry.type, true); view.setUint32(92, entry.protocol, true);
    view.setUint32(96, entry.family === 6 || entry.type === 3 ? 255 : 0, true);
    view.setUint32(108, entry.type === 1 ? 0 : entry.type === 3 ? 65535 : entry.family === 6 ? 546 : entry.family === 23 ? 65527 : 65507, true);
    for (let i = 0; i < entry.name.length; i++) if (wide) view.setUint16(116 + i * 2, entry.name.charCodeAt(i), true);
    else output[116 + i] = entry.name.charCodeAt(i);
    return output;
}
