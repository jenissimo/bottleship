/**
 * WSOCK32 (Winsock 1.1) module backed by the shared virtual LAN provider.
 */

import { IModule } from "../core/module";
import { wsock32Module } from "../api/wsock32.api";
import { Process } from "../core/process";
import { installWsaBlockingHooks } from "./wsa-blocking";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import {
    makeWsaStartup,
    makeWsaCleanup,
    getWsaProcessState,
    type WsaProcessState,
    WsaSocketTable,
    makeSocketExports,
    inetAddr,
    createDnsStubs,
    createProtoServStubs,
    createAsyncLookupStubs,
    makeSelect,
    makeFdIsSet,
    WSAEFAULT,
} from "./wsa-stub-shared";

const SOCKET_ERROR = -1;

export class Wsock32 implements IModule {
    name = "wsock32";
    exports: Record<string, ThunkImplementation> = {};
    private socketTable!: WsaSocketTable;
    private wsaState?: WsaProcessState;

    initialize(process: Process): void {
        const state = this.wsaState = getWsaProcessState(process);
        this.socketTable = state.table;

        const htons = (_ctx: unknown, _mem: unknown, args: number[]) => {
            const value = args[0] ?? 0;
            return ((value & 0xff) << 8) | ((value >>> 8) & 0xff);
        };
        const htonl = (_ctx: unknown, _mem: unknown, args: number[]) => {
            const value = args[0] ?? 0;
            return (
                ((value & 0xff) << 24) |
                ((value & 0xff00) << 8) |
                ((value >>> 8) & 0xff00) |
                ((value >>> 24) & 0xff)
            ) >>> 0;
        };
        const getLastError = () => state.getError() >>> 0;
        const setLastError = (_ctx: unknown, _mem: unknown, args: number[]) => {
            state.setError((args[0] ?? 0) | 0);
            return 0;
        };
        const setError = state.setError;
        const startup = makeWsaStartup(setError, WSAEFAULT, SOCKET_ERROR, state.counter);
        const socketExports = makeSocketExports(this.socketTable, setError, state.counter, process, true);
        const dns = createDnsStubs(process, setError);
        const protoServ = createProtoServStubs(process, setError);
        const asyncLookup = createAsyncLookupStubs(setError, process);
        const selectImpl = makeSelect(this.socketTable, setError, state.counter);
        const fdIsSet = makeFdIsSet();

        const wsaAsyncSelect = socketExports.WSAAsyncSelect!;

        this.exports["WSAStartup"] = startup;
        const cleanup = makeWsaCleanup(state.counter, setError);
        this.exports["WSACleanup"] = cleanup;
        this.exports["WSAGetLastError"] = getLastError;
        this.exports["WSASetLastError"] = setLastError;
        const publicSockets = new Set(wsock32Module.functions.map(fn => fn.name));
        Object.assign(this.exports, Object.fromEntries(Object.entries(socketExports).filter(([name]) => publicSockets.has(name))));
        this.exports["gethostbyname"] = dns.gethostbyname;
        this.exports["gethostname"] = dns.gethostname;
        this.exports["inet_addr"] = inetAddr; // faithful dotted-string parse (was always INADDR_NONE)
        this.exports["inet_ntoa"] = dns.inetNtoa;
        this.exports["htons"] = htons;
        this.exports["htonl"] = htonl;
        this.exports["ntohs"] = htons;
        this.exports["ntohl"] = htonl;
        this.exports["getpeername"] = socketExports.getpeername!;
        this.exports["getsockname"] = socketExports.getsockname!;
        this.exports["gethostbyaddr"] = dns.gethostbyaddr;
        this.exports["getprotobyname"] = protoServ.getprotobyname;
        this.exports["getprotobynumber"] = protoServ.getprotobynumber;
        this.exports["getservbyname"] = protoServ.getservbyname;
        this.exports["getservbyport"] = protoServ.getservbyport;
        this.exports["select"] = selectImpl;
        this.exports["__WSAFDIsSet"] = fdIsSet;
        this.exports["sendto"] = socketExports.sendto!;
        this.exports["recvfrom"] = socketExports.recvfrom!;
        this.exports["shutdown"] = socketExports.shutdown!;
        this.exports["WSAAsyncSelect"] = wsaAsyncSelect;
        this.exports["WSAAsyncGetHostByAddr"] = asyncLookup.WSAAsyncGetHostByAddr;
        this.exports["WSAAsyncGetHostByName"] = asyncLookup.WSAAsyncGetHostByName;
        this.exports["WSAAsyncGetProtoByNumber"] = asyncLookup.WSAAsyncGetProtoByNumber;
        this.exports["WSAAsyncGetProtoByName"] = asyncLookup.WSAAsyncGetProtoByName;
        this.exports["WSAAsyncGetServByPort"] = asyncLookup.WSAAsyncGetServByPort;
        this.exports["WSAAsyncGetServByName"] = asyncLookup.WSAAsyncGetServByName;
        this.exports["WSACancelAsyncRequest"] = asyncLookup.WSACancelAsyncRequest;
        this.exports["ioctlsocket"] = socketExports.ioctlsocket!;
        this.exports["setsockopt"] = socketExports.setsockopt!;
        this.exports["getsockopt"] = socketExports.getsockopt!;

        // Ordinal exports (PE imports by ord_N) — numbering per wsock32.dll's export table.
        this.exports["ord_1"] = socketExports.accept!;
        this.exports["ord_2"] = socketExports.bind!;
        this.exports["ord_3"] = socketExports.closesocket!;
        this.exports["ord_4"] = socketExports.connect!;
        this.exports["ord_5"] = socketExports.getpeername!;
        this.exports["ord_6"] = socketExports.getsockname!;
        this.exports["ord_7"] = socketExports.getsockopt!;
        this.exports["ord_8"] = htonl;
        this.exports["ord_9"] = htons;
        this.exports["ord_10"] = this.exports["inet_addr"];
        this.exports["ord_11"] = dns.inetNtoa;
        this.exports["ord_12"] = socketExports.ioctlsocket!;
        this.exports["ord_13"] = socketExports.listen!;
        this.exports["ord_14"] = htonl;
        this.exports["ord_15"] = htons;
        this.exports["ord_16"] = socketExports.recv!;
        this.exports["ord_17"] = socketExports.recvfrom!;
        this.exports["ord_18"] = selectImpl;
        this.exports["ord_19"] = socketExports.send!;
        this.exports["ord_20"] = socketExports.sendto!;
        this.exports["ord_21"] = socketExports.setsockopt!;
        this.exports["ord_22"] = socketExports.shutdown!;
        this.exports["ord_23"] = socketExports.socket!;
        this.exports["ord_51"] = dns.gethostbyaddr;
        this.exports["ord_52"] = dns.gethostbyname;
        this.exports["ord_53"] = protoServ.getprotobyname;
        this.exports["ord_54"] = protoServ.getprotobynumber;
        this.exports["ord_55"] = protoServ.getservbyname;
        this.exports["ord_56"] = protoServ.getservbyport;
        this.exports["ord_57"] = dns.gethostname;
        this.exports["ord_101"] = wsaAsyncSelect;
        this.exports["ord_102"] = asyncLookup.WSAAsyncGetHostByAddr;
        this.exports["ord_103"] = asyncLookup.WSAAsyncGetHostByName;
        this.exports["ord_104"] = asyncLookup.WSAAsyncGetProtoByNumber;
        this.exports["ord_105"] = asyncLookup.WSAAsyncGetProtoByName;
        this.exports["ord_106"] = asyncLookup.WSAAsyncGetServByPort;
        this.exports["ord_107"] = asyncLookup.WSAAsyncGetServByName;
        this.exports["ord_108"] = asyncLookup.WSACancelAsyncRequest;      // WSACancelAsyncRequest
        this.exports["ord_111"] = getLastError; // WSAGetLastError
        this.exports["ord_112"] = setLastError; // WSASetLastError
        this.exports["ord_115"] = startup; // WSAStartup
        this.exports["ord_116"] = cleanup; // WSACleanup
        this.exports["ord_1107"] = socketExports.WSARecvEx!;
        this.exports["ord_1140"] = socketExports.TransmitFile!;
        this.exports["ord_1141"] = socketExports.AcceptEx!;
        this.exports["ord_1142"] = socketExports.GetAcceptExSockaddrs!;
        this.exports["ord_151"] = fdIsSet; // __WSAFDIsSet
        installWsaBlockingHooks(this.exports, wsock32Module, state, process);
    }

    reset(): void {
        this.wsaState?.reset();
    }
}
