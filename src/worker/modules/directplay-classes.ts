import type { HleComClass } from '../core/com/hle-com-server';
export const DIRECTPLAY_COM_CLASSES: readonly HleComClass[] = [
    { clsid: 'd1eb6d20-8923-11d0-9d97-00a0c90a43cb',
      interfaces: ['IDirectPlay4A', 'IDirectPlay4', 'IDirectPlay3A', 'IDirectPlay3', 'IDirectPlay2A', 'IDirectPlay2', 'IDirectPlay'] },
    { clsid: '2fe8f810-b2a5-11d0-a787-0000f803abfc',
      interfaces: ['IDirectPlayLobby3A', 'IDirectPlayLobby3', 'IDirectPlayLobby2A', 'IDirectPlayLobby2', 'IDirectPlayLobbyA', 'IDirectPlayLobby'] },
];
export const DIRECTPLAY8_COM_CLASSES: readonly HleComClass[] = [
    { clsid: '934a9523-a3ca-4bc5-ada0-d6d95d979421',
      interfaces: ['IDirectPlay8Address', 'IDirectPlay8AddressIP'], clearCreateOutputOnFailure: false },
    { clsid: '286f484d-375e-4458-a272-b138e2f80a6a', interfaces: ['IDirectPlay8Peer'] },
    { clsid: '743f1dc6-5aba-429f-8bdf-c54d03253dc2', interfaces: ['IDirectPlay8Client'] },
    { clsid: 'da825e1b-6830-43d7-835d-0b5ad82956a2', interfaces: ['IDirectPlay8Server'] },
    { clsid: 'fc47060e-6153-4b34-b975-8e4121eb7f3c', interfaces: ['IDirectPlay8ThreadPool'] },
];
