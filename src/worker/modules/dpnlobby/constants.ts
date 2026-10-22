import type { HleComClass } from "../../core/com/hle-com-server";
export const DPL8_CLIENT = "819074a2-016c-11d3-ae14-006097b01411";
export const DPL8_APP = "819074a3-016c-11d3-ae14-006097b01411";
export const DPNLOBBY_COM_CLASSES: readonly HleComClass[] = [
    { clsid: "3b2b6775-70b6-45af-8dea-a209c69559f3", interfaces: ["IDirectPlay8LobbyClient"] },
    { clsid: "667955ad-6b3b-43ca-b949-bc69b5baff7f", interfaces: ["IDirectPlay8LobbiedApplication"] },
];
export const LOBBY8_TOPIC = "directplay8-lobby";
export const LOBBY8_NOTIFY = "directplay8-lobby-notification";
export const LOBBY8_REGISTRY = "Software\\Microsoft\\DirectPlay8\\Applications";
