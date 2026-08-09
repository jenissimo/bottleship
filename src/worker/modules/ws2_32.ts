/**
 * WS2_32 (Winsock 2) stub module.
 * Ordinal layout follows ws2_32.dll (differs from wsock32 for several slots).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";
import { hypercallDataManager } from "../core/cpu/hypercall-data";
import {
    SOCKET_ERROR,
    WSAEFAULT,
    WsaSocketTable,
    makeSocketExports,
    makeWsaStartup,
    inetAddr,
    createDnsStubs,
    createProtoServStubs,
    createAsyncLookupStubs,
    makeSelect,
    makeFdIsSet,
    WSAENOTSOCK,
    WSAENOTCONN,
    WSAEWOULDBLOCK,
} from "./wsa-stub-shared";

const WSA_INVALID_EVENT = 0xffffffff;
const WSANOTINITIALISED = 10093;
const WSAEINVAL = 10022;
const WSAEOPNOTSUPP = 10045;
const WSA_WAIT_TIMEOUT = 258;
const WSA_WAIT_FAILED = 0xffffffff;

export class Ws2_32 implements IModule {
    name = "ws2_32";
    exports: Record<string, ThunkImplementation> = {};
    private socketTable = new WsaSocketTable();
    private wsaStarted = false;

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

        const requireStarted = (): boolean => {
            if (this.wsaStarted) return true;
            setError(WSANOTINITIALISED);
            return false;
        };

        this.exports["WSAStartup"] = (ctx, mem, args) => {
            const result = startup(ctx, mem, args);
            if (typeof result === "number" && result === 0) {
                this.wsaStarted = true;
            }
            return result;
        };
        this.exports["WSACleanup"] = () => {
            this.wsaStarted = false;
            return 0;
        };
        this.exports["WSAGetLastError"] = getLastError;
        this.exports["WSASetLastError"] = setLastError;
        Object.assign(this.exports, socketExports);
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
        this.exports["select"] = selectImpl;
        this.exports["__WSAFDIsSet"] = fdIsSet;
        this.exports["WSAAsyncSelect"] = (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!this.socketTable.isValid(s)) {
                setError(WSAENOTSOCK);
                return SOCKET_ERROR;
            }
            setError(0);
            return 0;
        };
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
        // WSAAccept(s, addr, addrlen, lpfnCondition, dwCallbackData) — condition proc ignored in stub
        this.exports["WSAAccept"] = socketExports.accept!;
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
        this.exports["ord_108"] = ok;        // WSACancelAsyncRequest
        this.exports["ord_109"] = ok;        // WSASetBlockingHook
        this.exports["ord_110"] = ok;        // WSAUnhookBlockingHook
        this.exports["ord_111"] = getLastError;
        this.exports["ord_112"] = setLastError;
        this.exports["ord_113"] = ok;        // WSACancelBlockingCall
        this.exports["ord_114"] = ok;        // WSAIsBlocking
        this.exports["ord_115"] = this.exports["WSAStartup"]!;
        this.exports["ord_116"] = this.exports["WSACleanup"]!;
        // ord_151 diverges from wsock32 here: real ws2_32.dll assigns 151 to WSASocketA,
        // not __WSAFDIsSet (which ws2_32 only exports by name, no fixed ordinal).
        this.exports["ord_151"] = socketExports.WSASocketA!;

        this.exports["WSACreateEvent"] = () => {
            if (!requireStarted()) return WSA_INVALID_EVENT;
            return System.getInstance().scheduler.createEvent(true, false) >>> 0;
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

        this.exports["WSAWaitForMultipleEvents"] = (_ctx, _mem, args) => {
            if (!requireStarted()) return WSA_WAIT_FAILED;
            const count = args[0] >>> 0;
            const handlesPtr = args[1] >>> 0;
            const waitAll = (args[2] >>> 0) !== 0;
            const timeout = args[3] >>> 0;
            if (count === 0 || !handlesPtr) {
                setError(WSAEINVAL);
                return WSA_WAIT_FAILED;
            }
            const sched = System.getInstance().scheduler;
            const threadId = sched.getCurrentThreadId();
            const threadLookup = () => null;
            for (let i = 0; i < count; i++) {
                const handle = Mem.readUint32(handlesPtr + i * 4) ?? 0;
                if (sched.syncObjects.isSignaled(handle >>> 0, threadId, threadLookup)) {
                    return i >>> 0;
                }
            }
            if (timeout === 0) {
                return WSA_WAIT_TIMEOUT;
            }
            if (waitAll && count > 1) {
                return WSA_WAIT_TIMEOUT;
            }
            return 0;
        };

        this.exports["WSAEventSelect"] = (_ctx, _mem, args) => {
            if (!requireStarted()) return SOCKET_ERROR;
            const socket = args[0] | 0;
            if (!this.socketTable.isValid(socket)) {
                setError(WSAEINVAL);
                return SOCKET_ERROR;
            }
            return 0;
        };

        this.exports["WSAEnumNetworkEvents"] = (_ctx, mem, args) => {
            if (!requireStarted()) return SOCKET_ERROR;
            const socket = args[0] | 0;
            const lpNetworkEvents = args[2] >>> 0;
            if (!this.socketTable.isValid(socket) || !lpNetworkEvents || lpNetworkEvents + 8 > mem.length) {
                setError(WSAEINVAL);
                return SOCKET_ERROR;
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpNetworkEvents, 0, true);
            view.setUint32(lpNetworkEvents + 4, 0, true);
            return 0;
        };

        // Winsock 2 scatter/gather over the same socket table as send/recv. The
        // non-overlapped form is the whole contract we can honor; an OVERLAPPED request or
        // completion routine is refused outright, because the alternative is a caller
        // waiting forever on a completion nothing will ever post. Declared-but-unhandled
        // is not an option here: that path returns 50, which is neither 0 nor SOCKET_ERROR.
        const wsaBufTotal = (lpBuffers: number, count: number): number => {
            let total = 0;
            for (let i = 0; i < count; i++) total += (Mem.readUint32(lpBuffers + i * 8) ?? 0) >>> 0;
            return total;
        };
        const wsaSend = (args: number[], overlappedIdx: number): number => {
            if (!requireStarted()) return SOCKET_ERROR;
            const s = args[0] | 0;
            if (args[overlappedIdx] || args[overlappedIdx + 1]) {
                setError(WSAEOPNOTSUPP);
                return SOCKET_ERROR;
            }
            if (args[3]) Mem.writeUint32(args[3] >>> 0, 0);
            if (!this.socketTable.isValid(s)) {
                setError(WSAENOTSOCK);
                return SOCKET_ERROR;
            }
            if (!args[1] || !args[2]) {
                setError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const sent = this.socketTable.send(s, wsaBufTotal(args[1] >>> 0, args[2] >>> 0));
            if (sent === SOCKET_ERROR) {
                setError(WSAENOTCONN);
                return SOCKET_ERROR;
            }
            if (args[3]) Mem.writeUint32(args[3] >>> 0, sent >>> 0);
            setError(0);
            return 0;
        };
        const wsaRecv = (args: number[], overlappedIdx: number): number => {
            if (!requireStarted()) return SOCKET_ERROR;
            const s = args[0] | 0;
            if (args[overlappedIdx] || args[overlappedIdx + 1]) {
                setError(WSAEOPNOTSUPP);
                return SOCKET_ERROR;
            }
            if (args[3]) Mem.writeUint32(args[3] >>> 0, 0);
            if (args[4]) Mem.writeUint32(args[4] >>> 0, 0);
            if (!this.socketTable.isValid(s)) {
                setError(WSAENOTSOCK);
                return SOCKET_ERROR;
            }
            // The table never has data pending, so a recv is always "would block".
            setError(this.socketTable.recv(s) === SOCKET_ERROR ? WSAEWOULDBLOCK : 0);
            return SOCKET_ERROR;
        };
        this.exports["WSASend"] = (_ctx, _mem, args) => wsaSend(args, 5);
        this.exports["WSASendTo"] = (_ctx, _mem, args) => wsaSend(args, 7);
        this.exports["WSARecv"] = (_ctx, _mem, args) => wsaRecv(args, 5);
        this.exports["WSARecvFrom"] = (_ctx, _mem, args) => wsaRecv(args, 7);
        this.exports["WSAGetOverlappedResult"] = (_ctx, _mem, args) => {
            if (args[2]) Mem.writeUint32(args[2] >>> 0, 0);
            if (args[4]) Mem.writeUint32(args[4] >>> 0, 0);
            setError(WSAEOPNOTSUPP);
            return 0;   // FALSE — no overlapped request was ever accepted
        };

        this.exports["inet_pton"] = () => 0;
    }

    reset(): void {
        this.socketTable.reset();
        this.wsaStarted = false;
    }
}
