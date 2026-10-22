/**
 * WS2_32 (Winsock 2) module backed by the shared virtual LAN provider.
 * Ordinal layout follows ws2_32.dll (differs from wsock32 for several slots).
 */

import { IModule } from "../core/module";
import { ws2_32Module } from "../api/ws2_32.api";
import { Process } from "../core/process";
import { installWsaBlockingHooks } from "./wsa-blocking";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { deliverPendingApcs } from "./kernel32/sync";
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { hypercallDataManager } from "../core/cpu/hypercall-data";
import { WAIT_BLOCKED_NO_SWITCH } from "../core/scheduler/types";
import {
    SOCKET_ERROR,
    WSAEFAULT,
    WsaSocketTable,
    makeSocketExports,
    makeWsaStartup,
    makeWsaCleanup,
    getWsaProcessState,
    type WsaProcessState,
    inetAddr,
    createDnsStubs,
    createProtoServStubs,
    createAddrInfoStubs,
    createAsyncLookupStubs,
    makeSelect,
    makeFdIsSet,
    WSAENOTSOCK,
    WSAENOTCONN,
    WSAEWOULDBLOCK,
} from "./wsa-stub-shared";

const WSA_INVALID_EVENT = 0;
const WSANOTINITIALISED = 10093;
const WSAEINVAL = 10022;
const WSAEOPNOTSUPP = 10045;
const WSA_WAIT_TIMEOUT = 258;
const WSA_WAIT_FAILED = 0xffffffff;

export class Ws2_32 implements IModule {
    name = "ws2_32";
    exports: Record<string, ThunkImplementation> = {};
    private socketTable!: WsaSocketTable;
    private wsaState?: WsaProcessState;
    private resetAddrInfo: (() => void) | null = null;

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
        const socketExports = makeSocketExports(this.socketTable, setError, state.counter, process);
        const dns = createDnsStubs(process, setError);
        const protoServ = createProtoServStubs(process, setError);
        const addrInfo = createAddrInfoStubs(process, setError);
        this.resetAddrInfo = addrInfo.reset;
        const asyncLookup = createAsyncLookupStubs(setError, process);
        const selectImpl = makeSelect(this.socketTable, setError, state.counter);
        const fdIsSet = makeFdIsSet();

        const requireStarted = (): boolean => {
            if (state.counter.started) return true;
            setError(WSANOTINITIALISED);
            return false;
        };

        this.exports["WSAStartup"] = startup;
        this.exports["WSACleanup"] = makeWsaCleanup(state.counter, setError);
        this.exports["WSAGetLastError"] = getLastError;
        this.exports["WSASetLastError"] = setLastError;
        const publicSockets = new Set(ws2_32Module.functions.map(fn => fn.name));
        Object.assign(this.exports, Object.fromEntries(Object.entries(socketExports).filter(([name]) => publicSockets.has(name))));
        this.exports["htons"] = htons;
        this.exports["htonl"] = htonl;
        this.exports["ntohs"] = htons;
        this.exports["ntohl"] = htonl;
        this.exports["inet_addr"] = inetAddr;
        this.exports["inet_ntoa"] = dns.inetNtoa;
        this.exports["gethostbyname"] = dns.gethostbyname;
        this.exports["gethostbyaddr"] = dns.gethostbyaddr;
        this.exports["gethostname"] = dns.gethostname;
        this.exports["getprotobyname"] = protoServ.getprotobyname;
        this.exports["getprotobynumber"] = protoServ.getprotobynumber;
        this.exports["getservbyname"] = protoServ.getservbyname;
        this.exports["getservbyport"] = protoServ.getservbyport;
        this.exports["getaddrinfo"] = addrInfo.getaddrinfo;
        this.exports["freeaddrinfo"] = addrInfo.freeaddrinfo;
        this.exports["getnameinfo"] = addrInfo.getnameinfo;
        this.exports["select"] = selectImpl;
        this.exports["__WSAFDIsSet"] = fdIsSet;
        this.exports["WSAAsyncSelect"] = socketExports.WSAAsyncSelect!;
        this.exports["WSAAsyncGetHostByAddr"] = asyncLookup.WSAAsyncGetHostByAddr;
        this.exports["WSAAsyncGetHostByName"] = asyncLookup.WSAAsyncGetHostByName;
        this.exports["WSAAsyncGetProtoByNumber"] = asyncLookup.WSAAsyncGetProtoByNumber;
        this.exports["WSAAsyncGetProtoByName"] = asyncLookup.WSAAsyncGetProtoByName;
        this.exports["WSAAsyncGetServByPort"] = asyncLookup.WSAAsyncGetServByPort;
        this.exports["WSAAsyncGetServByName"] = asyncLookup.WSAAsyncGetServByName;
        this.exports["WSACancelAsyncRequest"] = asyncLookup.WSACancelAsyncRequest;
        // Conditional accept runs the application callback on its owning guest thread.
        this.exports["WSAAccept"] = socketExports.WSAAccept!;
        this.exports["WSAIoctl"] = socketExports.WSAIoctl!;

        // Ordinal exports — authoritative ws2_32.dll layout: the Berkeley socket functions
        // occupy ordinals 1-23, same numbering wsock32.dll uses (kept in sync so an ordinal
        // import from either DLL gets the same arg count / stack cleanup).
        this.exports["ord_1"] = socketExports.accept!;        // accept
        this.exports["ord_2"] = socketExports.bind!;          // bind
        this.exports["ord_3"] = socketExports.closesocket!;   // closesocket
        this.exports["ord_4"] = socketExports.connect!;       // connect
        this.exports["ord_5"] = socketExports.getpeername!;   // getpeername
        this.exports["ord_6"] = socketExports.getsockname!;   // getsockname
        this.exports["ord_7"] = socketExports.getsockopt!;    // getsockopt
        this.exports["ord_8"] = htonl;                        // htonl
        this.exports["ord_9"] = htons;                        // htons
        this.exports["ord_10"] = socketExports.ioctlsocket!;  // ioctlsocket
        this.exports["ord_11"] = inetAddr;                    // inet_addr
        this.exports["ord_12"] = dns.inetNtoa;                // inet_ntoa
        this.exports["ord_13"] = socketExports.listen!;       // listen
        this.exports["ord_14"] = htonl;                       // ntohl (symmetric byte swap)
        this.exports["ord_15"] = htons;                       // ntohs (symmetric byte swap)
        this.exports["ord_16"] = socketExports.recv!;         // recv
        this.exports["ord_17"] = socketExports.recvfrom!;     // recvfrom
        this.exports["ord_18"] = selectImpl;                  // select
        this.exports["ord_19"] = socketExports.send!;         // send
        this.exports["ord_20"] = socketExports.sendto!;       // sendto
        this.exports["ord_21"] = socketExports.setsockopt!;   // setsockopt
        this.exports["ord_22"] = socketExports.shutdown!;     // shutdown
        this.exports["ord_23"] = socketExports.socket!;       // socket
        this.exports["ord_51"] = dns.gethostbyaddr;  // gethostbyaddr
        this.exports["ord_52"] = dns.gethostbyname;  // gethostbyname
        this.exports["ord_53"] = protoServ.getprotobyname;   // getprotobyname
        this.exports["ord_54"] = protoServ.getprotobynumber; // getprotobynumber
        this.exports["ord_55"] = protoServ.getservbyname;    // getservbyname
        this.exports["ord_56"] = protoServ.getservbyport;    // getservbyport
        this.exports["ord_57"] = dns.gethostname;    // gethostname
        this.exports["ord_101"] = this.exports["WSAAsyncSelect"]!;
        this.exports["ord_102"] = asyncLookup.WSAAsyncGetHostByAddr;
        this.exports["ord_103"] = asyncLookup.WSAAsyncGetHostByName;
        this.exports["ord_104"] = asyncLookup.WSAAsyncGetProtoByNumber;
        this.exports["ord_105"] = asyncLookup.WSAAsyncGetProtoByName;
        this.exports["ord_106"] = asyncLookup.WSAAsyncGetServByPort;
        this.exports["ord_107"] = asyncLookup.WSAAsyncGetServByName;
        this.exports["ord_108"] = asyncLookup.WSACancelAsyncRequest;        // WSACancelAsyncRequest
        this.exports["ord_111"] = getLastError;
        this.exports["ord_112"] = setLastError;
        this.exports["ord_115"] = this.exports["WSAStartup"]!;
        this.exports["ord_116"] = this.exports["WSACleanup"]!;
        this.exports["ord_151"] = fdIsSet;    // __WSAFDIsSet, same slot as wsock32

        this.exports["WSACreateEvent"] = () => {
            if (!requireStarted()) return WSA_INVALID_EVENT;
            const handle = System.getInstance().scheduler.createEvent(true, false) >>> 0;
            setError(0); return handle;
        };

        this.exports["WSACloseEvent"] = (_ctx, _mem, args) => {
            if (!requireStarted()) return 0;
            const handle = args[0] >>> 0;
            const resource = System.getInstance().resourceProvider.getKernelObject(handle);
            if (!resource || resource.kind !== "event") {
                setError(WSAEINVAL);
                return 0;
            }
            hypercallDataManager.unregisterEventMirror(handle);
            System.getInstance().resourceProvider.unregisterKernelObject(handle);
            return 1;
        };

        this.exports["WSASetEvent"] = (_ctx, _mem, args) => {
            if (!requireStarted()) return 0;
            const ok = System.getInstance().scheduler.setEvent(args[0] >>> 0);
            if (!ok) {
                setError(WSAEINVAL);
                return 0;
            }
            return 1;
        };

        this.exports["WSAResetEvent"] = (_ctx, _mem, args) => {
            if (!requireStarted()) return 0;
            const ok = System.getInstance().scheduler.resetEvent(args[0] >>> 0);
            if (!ok) {
                setError(WSAEINVAL);
                return 0;
            }
            return 1;
        };

        /**
         * A real wait, not a poll. Returning WSA_WAIT_EVENT_0 when nothing is signalled tells
         * the caller an event fired: it resets the event and waits again, and the thread spins
         * at full speed forever — 16 million round trips before this was a wait. The result
         * codes coincide with the Win32 ones (EVENT_0 = OBJECT_0 = 0, TIMEOUT = 258,
         * FAILED = 0xFFFFFFFF), so the scheduler's answer is returned unchanged.
         */
        this.exports["WSAWaitForMultipleEvents"] = (ctx, mem, args) => {
            if (!requireStarted()) return WSA_WAIT_FAILED;
            const count = args[0] >>> 0;
            const handlesPtr = args[1] >>> 0;
            const waitAll = (args[2] >>> 0) !== 0;
            const timeout = args[3] >>> 0;
            if (count === 0 || count > 64 || !handlesPtr || handlesPtr + count * 4 > mem.length) {
                setError(WSAEINVAL);
                return WSA_WAIT_FAILED;
            }
            const handles: number[] = [];
            for (let i = 0; i < count; i++) handles.push((Mem.readUint32(handlesPtr + i * 4) ?? 0) >>> 0);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const returnAddr = view.getUint32(ctx.esp, true);
            // 4 (return address) + 5 args
            const postReturnEsp = ctx.esp + 24;

            const sched = System.getInstance().scheduler;
            if (args[4]) { const apcs = deliverPendingApcs(ctx, "WSAWaitForMultipleEvents:APC", 20); if (apcs) return apcs; }
            const result = sched.waitForObjectsWithContext(
                handles,
                waitAll,
                timeout,
                returnAddr,
                postReturnEsp,
                { ecx: ctx.ecx, edx: ctx.edx, ebx: ctx.ebx, ebp: ctx.ebp, esi: ctx.esi, edi: ctx.edi, eflags: ctx.eflags },
                !!args[4],
            );
            if (result === WAIT_BLOCKED_NO_SWITCH) {
                return { value: 0, blockedNoSwitch: true, stackCleanup: 20 };
            }
            return result >>> 0;
        };

        for (const name of ["WSAEventSelect", "WSAEnumNetworkEvents", "WSASend", "WSASendTo",
            "WSARecv", "WSARecvFrom", "WSAGetOverlappedResult"]) this.exports[name] = socketExports[name]!;
        installWsaBlockingHooks(this.exports, ws2_32Module, state, process);

    }

    reset(): void {
        this.wsaState?.reset();
        this.resetAddrInfo?.();
    }
}
