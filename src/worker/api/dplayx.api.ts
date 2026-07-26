/**
 * DirectPlay (dplayx) API Descriptor
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

const p = (name: string): ParameterDescriptor => ({ name, type: "ptr" });
const u = (name: string): ParameterDescriptor => ({ name, type: "u32" });

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const makeMethod = (
    name: string,
    argCount: number,
    overrides: Partial<FunctionDescriptor> = {}
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

// IDirectPlayLobby3A interface (DirectPlay 7 era)
// Method order is based on IDirectPlayLobbyA -> IDirectPlayLobby2A -> IDirectPlayLobby3A.
export const IDirectPlayLobby3A: InterfaceDescriptor = {
    name: "IDirectPlayLobby3A",
    inherits: "IUnknown",
    iid: "2db72491-652c-11d1-a7a8-0000f803abfc",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Connect", 4),
        makeMethod("CreateAddress", 7),
        makeMethod("EnumAddresses", 5),
        makeMethod("EnumAddressTypes", 5),
        makeMethod("EnumLocalApplications", 4),

        // IDirectPlayLobby3::GetConnectionSettings(dwAppID, lpData, lpdwDataSize) = 3 args + this = 4.
        // NOTE: IDirectPlay8LobbyClient has 5 params (different interface, has dwFlags). Don't confuse them.
        makeMethod("GetConnectionSettings", 4),

        makeMethod("ReceiveLobbyMessage", 6),
        makeMethod("RunApplication", 5),
        makeMethod("SendLobbyMessage", 5),
        makeMethod("SetConnectionSettings", 4),
        makeMethod("SetLobbyMessageEvent", 4),
        makeMethod("CreateCompoundAddress", 5),
        makeMethod("ConnectEx", 5),
        makeMethod("RegisterApplication", 3),
        makeMethod("UnregisterApplication", 3),
        makeMethod("WaitForConnectionSettings", 2),
    ],
};

// Legacy Lobby interface used by IFC20 in HoMM3.
// IID: {5959df62-2911-11d1-b049-0020af30269a}
// The binary uses vtable slots compatible with old Lobby signatures:
// - CreateAddress is called with 4 args after this (5 total)
// - EnumLocalApplications is called with 2 args after this (3 total)
export const IDirectPlayLobbyCompatA: InterfaceDescriptor = {
    name: "IDirectPlayLobbyCompatA",
    inherits: "IUnknown",
    iid: "5959df62-2911-11d1-b049-0020af30269a",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Connect", 4),
        makeMethod("CreateAddress", 5),
        makeMethod("EnumAddresses", 5),
        makeMethod("EnumAddressTypes", 5),
        makeMethod("EnumLocalApplications", 3),

        // Same as Lobby3A: 3 args + this = 4.
        makeMethod("GetConnectionSettings", 4),

        makeMethod("ReceiveLobbyMessage", 6),
        makeMethod("RunApplication", 5),
        makeMethod("SendLobbyMessage", 5),
        makeMethod("SetConnectionSettings", 4),
        makeMethod("SetLobbyMessageEvent", 4),
        makeMethod("CreateCompoundAddress", 5),
        makeMethod("ConnectEx", 5),
        makeMethod("RegisterApplication", 3),
        makeMethod("UnregisterApplication", 3),
        makeMethod("WaitForConnectionSettings", 2),
    ],
};

// IDirectPlay4A interface (DirectPlay 7 era)
// Vtable order: IUnknown(0-2) + IDirectPlay2(3-31) + IDirectPlay3(32-44) + IDirectPlay4(45-52)
// Reference: dplay.h DECLARE_INTERFACE_(IDirectPlay4, IDirectPlay3)
export const IDirectPlay4A: InterfaceDescriptor = {
    name: "IDirectPlay4A",
    inherits: "IUnknown",
    iid: "0ab1c531-4745-11d1-a7a1-0000f803abfc",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // --- IDirectPlay2 methods (slots 3-31) ---
        makeMethod("AddPlayerToGroup", 3),          // 3: DPID, DPID
        makeMethod("Close", 1),                     // 4: void
        makeMethod("CreateGroup", 6),               // 5: LPDPID, LPDPNAME, LPVOID, DWORD, DWORD
        makeMethod("CreatePlayer", 7),              // 6: LPDPID, LPDPNAME, HANDLE, LPVOID, DWORD, DWORD
        makeMethod("DeletePlayerFromGroup", 3),     // 7: DPID, DPID
        makeMethod("DestroyGroup", 2),              // 8: DPID
        makeMethod("DestroyPlayer", 2),             // 9: DPID
        makeMethod("EnumGroupPlayers", 6),          // 10: DPID, LPGUID, callback, LPVOID, DWORD
        makeMethod("EnumGroups", 5),                // 11: LPGUID, callback, LPVOID, DWORD
        makeMethod("EnumPlayers", 5),               // 12: LPGUID, callback, LPVOID, DWORD
        makeMethod("EnumSessions", 6),              // 13: LPDPSESSIONDESC2, DWORD, callback, LPVOID, DWORD
        makeMethod("GetCaps", 3),                   // 14: LPDPCAPS, DWORD
        makeMethod("GetGroupData", 5),              // 15: DPID, LPVOID, LPDWORD, DWORD
        makeMethod("GetGroupName", 4),              // 16: DPID, LPVOID, LPDWORD
        makeMethod("GetMessageCount", 3),           // 17: DPID, LPDWORD
        makeMethod("GetPlayerAddress", 4),          // 18: DPID, LPVOID, LPDWORD
        makeMethod("GetPlayerCaps", 4),             // 19: DPID, LPDPCAPS, DWORD
        makeMethod("GetPlayerData", 5),             // 20: DPID, LPVOID, LPDWORD, DWORD
        makeMethod("GetPlayerName", 4),             // 21: DPID, LPVOID, LPDWORD
        makeMethod("GetSessionDesc", 3),            // 22: LPVOID, LPDWORD
        makeMethod("Initialize", 2),                // 23: LPGUID
        makeMethod("Open", 3),                      // 24: LPDPSESSIONDESC2, DWORD
        makeMethod("Receive", 6),                   // 25: LPDPID, LPDPID, DWORD, LPVOID, LPDWORD
        makeMethod("Send", 6),                      // 26: DPID, DPID, DWORD, LPVOID, DWORD
        makeMethod("SetGroupData", 5),              // 27: DPID, LPVOID, DWORD, DWORD
        makeMethod("SetGroupName", 4),              // 28: DPID, LPDPNAME, DWORD
        makeMethod("SetPlayerData", 5),             // 29: DPID, LPVOID, DWORD, DWORD
        makeMethod("SetPlayerName", 4),             // 30: DPID, LPDPNAME, DWORD
        makeMethod("SetSessionDesc", 3),            // 31: LPDPSESSIONDESC2, DWORD
        // --- IDirectPlay3 methods (slots 32-44) ---
        makeMethod("AddGroupToGroup", 3),           // 32: DPID, DPID
        makeMethod("CreateGroupInGroup", 7),        // 33: DPID, LPDPID, LPDPNAME, LPVOID, DWORD, DWORD
        makeMethod("DeleteGroupFromGroup", 3),      // 34: DPID, DPID
        makeMethod("EnumConnections", 5),           // 35: LPCGUID, callback, LPVOID, DWORD
        makeMethod("EnumGroupsInGroup", 6),         // 36: DPID, LPGUID, callback, LPVOID, DWORD
        makeMethod("GetGroupConnectionSettings", 5),// 37: DWORD, DPID, LPVOID, LPDWORD
        makeMethod("InitializeConnection", 3),      // 38: LPVOID, DWORD
        makeMethod("SecureOpen", 5),                // 39: LPCDPSESSIONDESC2, DWORD, LPCDPSECURITYDESC, LPCDPCREDENTIALS
        makeMethod("SendChatMessage", 5),           // 40: DPID, DPID, DWORD, LPDPCHAT
        makeMethod("SetGroupConnectionSettings", 4),// 41: DWORD, DPID, LPDPLCONNECTION
        makeMethod("StartSession", 3),              // 42: DWORD, DPID
        makeMethod("GetGroupFlags", 3),             // 43: DPID, LPDWORD
        makeMethod("GetGroupParent", 3),            // 44: DPID, LPDPID
        // --- IDirectPlay4 methods (slots 45-52) ---
        makeMethod("GetPlayerAccount", 5),          // 45: DPID, DWORD, LPVOID, LPDWORD
        makeMethod("GetPlayerFlags", 3),            // 46: DPID, LPDWORD
        makeMethod("GetGroupOwner", 3),             // 47: DPID, LPDPID
        makeMethod("SetGroupOwner", 3),             // 48: DPID, DPID
        makeMethod("SendEx", 10),                   // 49: DPID, DPID, DWORD, LPVOID, DWORD, DWORD, DWORD, LPVOID, LPDWORD
        makeMethod("GetMessageQueue", 6),           // 50: DPID, DPID, DWORD, LPDWORD, LPDWORD
        makeMethod("CancelMessage", 3),             // 51: DWORD, DWORD
        makeMethod("CancelPriority", 4),            // 52: DWORD, DWORD, DWORD
    ],
};

// IDirectPlayLobby interface (original)
// IID_IDirectPlayLobby: {af465c71-9588-11cf-a020-00aa006157ac}
// The ANSI variant IID_IDirectPlayLobbyA shares this exact vtable shape, so the object
// answers both (see DirectPlayLobbyObjectV1.queryAdditionalInterfaces).
export const IDirectPlayLobby: InterfaceDescriptor = {
    name: "IDirectPlayLobby",
    inherits: "IUnknown",
    iid: "af465c71-9588-11cf-a020-00aa006157ac",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Connect", 4),
        makeMethod("CreateAddress", 7),
        makeMethod("EnumAddresses", 5),
        makeMethod("EnumAddressTypes", 5),
        makeMethod("EnumLocalApplications", 4),
        makeMethod("GetConnectionSettings", 4),
        makeMethod("ReceiveLobbyMessage", 6),
        makeMethod("RunApplication", 5),
        makeMethod("SendLobbyMessage", 5),
        makeMethod("SetConnectionSettings", 4),
        makeMethod("SetLobbyMessageEvent", 4),
    ],
};

// IDirectPlay interface (original)
// IID_IDirectPlay: {5454e9a0-db65-11ce-921c-00aa006c4972}
export const IDirectPlay: InterfaceDescriptor = {
    name: "IDirectPlay",
    inherits: "IUnknown",
    iid: "5454e9a0-db65-11ce-921c-00aa006c4972",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("AddPlayerToGroup", 3),
        makeMethod("Close", 1),
        makeMethod("CreatePlayer", 5),
        makeMethod("CreateGroup", 4),
        makeMethod("DeletePlayerFromGroup", 3),
        makeMethod("DestroyPlayer", 2),
        makeMethod("DestroyGroup", 2),
        makeMethod("EnableNewPlayers", 2),
        makeMethod("EnumGroupPlayers", 5),
        makeMethod("EnumGroups", 5),
        makeMethod("EnumPlayers", 5),
        makeMethod("EnumSessions", 6),
        makeMethod("GetCaps", 2),
        makeMethod("GetMessageCount", 3),
        makeMethod("GetPlayerCaps", 3),
        makeMethod("GetPlayerName", 6),
        makeMethod("Initialize", 2),
        makeMethod("Open", 2),
        makeMethod("Receive", 6),
        makeMethod("SaveSession", 2),
        makeMethod("Send", 6),
        makeMethod("SetPlayerName", 4),
    ],
};

// DirectPlay 8 Lobby Client (DX8/DX9)
// IID_IDirectPlay8LobbyClient: {819074a2-016c-11d3-ae14-006097b01411}
// Not to be confused with IID_IDirectPlay8LobbiedApplication ({819074a3-...}), a distinct
// 12-slot interface (RegisterProgram/UnRegisterProgram/SetAppAvailable/UpdateStatus).
export const IDirectPlay8LobbyClient: InterfaceDescriptor = {
    name: "IDirectPlay8LobbyClient",
    inherits: "IUnknown",
    iid: "819074a2-016c-11d3-ae14-006097b01411",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        makeMethod("Initialize", 4, { params: [p("this"), p("pvUserContext"), p("pfn"), u("dwFlags")] }),
        makeMethod("EnumLocalPrograms", 6, {
            params: [p("this"), p("pGuidApplication"), p("pEnumData"), p("pdwEnumData"), p("pdwItems"), u("dwFlags")]
        }),
        makeMethod("ConnectApplication", 6, {
            params: [p("this"), p("pdplConnectionInfo"), p("pvConnectionContext"), p("hApplication"), u("dwTimeOut"), u("dwFlags")]
        }),
        makeMethod("Send", 5, { params: [p("this"), u("hConnection"), p("pBuffer"), u("pBufferSize"), u("dwFlags")] }),
        makeMethod("ReleaseApplication", 3, { params: [p("this"), u("hConnection"), u("dwFlags")] }),
        makeMethod("Close", 2, { params: [p("this"), u("dwFlags")] }),
        makeMethod("GetConnectionSettings", 5, {
            params: [p("this"), u("hConnection"), p("pdplSessionInfo"), p("pdwInfoSize"), u("dwFlags")]
        }),
        makeMethod("SetConnectionSettings", 4, {
            params: [p("this"), u("hConnection"), p("pdplSessionInfo"), u("dwFlags")]
        }),
    ],
};

export const dplayxModule: ModuleDescriptor = {
    name: "dplayx",
    version: "7.0",
    description: "DirectPlay lobby stubs",
    functions: [
        {
            name: "DirectPlayCreate",
            ordinal: 1,
            params: [
                { name: "lpGUID", type: "ptr" },
                { name: "lplpDP", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectPlayEnumerateA",
            ordinal: 2,
            params: [
                { name: "lpEnumCallback", type: "ptr" },
                { name: "lpContext", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
        {
            name: "DirectPlayLobbyCreateA",
            ordinal: 4,
            params: [
                { name: "lpGUID", type: "ptr" },
                { name: "lplpDPL", type: "ptr", direction: "out" },
                { name: "pUnkOuter", type: "ptr" },
                { name: "lpData", type: "ptr" },
                { name: "dwDataSize", type: "u32" },
            ],
            returnType: "u32",
            callingConvention: "stdcall",
        },
    ],
    interfaces: [IDirectPlayLobby3A, IDirectPlayLobbyCompatA, IDirectPlay4A, IDirectPlayLobby, IDirectPlay, IDirectPlay8LobbyClient],
};
