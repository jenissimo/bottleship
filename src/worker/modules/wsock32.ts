/**
 * WSOCK32 (Winsock 1.1) stub module.
 * Keep behavior deterministic and fail unsupported networking paths safely.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import {
    makeWsaStartup,
    makeWsaCleanup,
    wsaStartupCount,
    WsaSocketTable,
    makeSocketExports,
    inetAddr,
    createDnsStubs,
    createProtoServStubs,
    createAsyncLookupStubs,
    makeSelect,
    makeFdIsSet,
    WSAEFAULT,
    WSAENOTSOCK,
} from "./wsa-stub-shared";

const SOCKET_ERROR = -1;

export class Wsock32 implements IModule {
    name = "wsock32";
    exports: Record<string, ThunkImplementation> = {};
    private socketTable = new WsaSocketTable();

    initialize(process: Process): void {
        let wsaLastError = 0;

        const ok = () => 0;
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
        const getLastError = () => wsaLastError >>> 0;
        const setLastError = (_ctx: unknown, _mem: unknown, args: number[]) => {
            wsaLastError = (args[0] ?? 0) | 0;
            return 0;
        };
        const setError = (code: number) => {
            wsaLastError = code | 0;
        };
        const startup = makeWsaStartup(setError, WSAEFAULT, SOCKET_ERROR);
        const socketExports = makeSocketExports(this.socketTable, setError);
        const dns = createDnsStubs(process, setError);
        const protoServ = createProtoServStubs(process, setError);
        const asyncLookup = createAsyncLookupStubs(setError);
        const selectImpl = makeSelect(this.socketTable, setError);
        const fdIsSet = makeFdIsSet();

        const wsaAsyncSelect: ThunkImplementation = (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!this.socketTable.isValid(s)) {
                setError(WSAENOTSOCK);
                return SOCKET_ERROR;
            }
            setError(0);
            return 0;
        };

        this.exports["WSAStartup"] = startup;
        const cleanup = makeWsaCleanup(wsaStartupCount, setError);
        this.exports["WSACleanup"] = cleanup;
        this.exports["WSAGetLastError"] = getLastError;
        this.exports["WSASetLastError"] = setLastError;
        Object.assign(this.exports, socketExports);
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
        this.exports["WSACancelAsyncRequest"] = ok;
        this.exports["WSASetBlockingHook"] = ok;
        this.exports["WSAUnhookBlockingHook"] = ok;
        this.exports["WSACancelBlockingCall"] = ok;
        this.exports["WSAIsBlocking"] = ok;
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
        this.exports["ord_108"] = ok;      // WSACancelAsyncRequest
        this.exports["ord_109"] = ok;      // WSASetBlockingHook
        this.exports["ord_110"] = ok;      // WSAUnhookBlockingHook
        this.exports["ord_111"] = getLastError; // WSAGetLastError
        this.exports["ord_112"] = setLastError; // WSASetLastError
        this.exports["ord_113"] = ok;      // WSACancelBlockingCall
        this.exports["ord_114"] = ok;      // WSAIsBlocking
        this.exports["ord_115"] = startup; // WSAStartup
        this.exports["ord_116"] = cleanup; // WSACleanup
        this.exports["ord_151"] = fdIsSet; // __WSAFDIsSet
    }

    reset(): void {
        this.socketTable.reset();
        wsaStartupCount.reset();
    }
}
