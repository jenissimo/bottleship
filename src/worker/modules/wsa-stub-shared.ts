/**
 * Shared Winsock stub helpers (WSAStartup WSADATA fill, ioctlsocket no-op).
 */

import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Process } from "../core/process";
import { System } from "../core/system";

/**
 * Faithful `inet_addr` (winsock 1.1 / 2). Parses a dotted-address string into an in_addr.s_addr
 * in NETWORK byte order — for "1.2.3.4" the on-wire bytes are [1,2,3,4], so on x86 (little endian)
 * the returned uint32 is 0x04030201. Supports the historical a / a.b / a.b.c / a.b.c.d forms and
 * decimal / octal (leading 0) / hex (0x) parts, per BSD/MS strtoul(base 0) rules. Returns
 * INADDR_NONE (0xFFFFFFFF) on malformed input (and, by the well-known quirk, for "255.255.255.255").
 * The previous stub returned INADDR_NONE unconditionally, so callers (e.g. GameSpy matchmaking in
 * ipdrv) could never resolve a server address.
 */
export function parseInetAddr(str: string): number {
    const INADDR_NONE = 0xffffffff;
    const s = str.trim();
    if (s.length === 0) return INADDR_NONE;
    const parts = s.split(".");
    if (parts.length === 0 || parts.length > 4) return INADDR_NONE;
    const vals: number[] = [];
    for (const p of parts) {
        let v: number;
        if (/^0[xX][0-9a-fA-F]+$/.test(p)) v = parseInt(p.slice(2), 16);
        else if (/^0[0-7]*$/.test(p)) v = parseInt(p, 8);          // "0" and octal
        else if (/^[1-9][0-9]*$/.test(p)) v = parseInt(p, 10);
        else return INADDR_NONE;
        if (!Number.isFinite(v) || v < 0) return INADDR_NONE;
        vals.push(v >>> 0);
    }
    let bytes: number[];
    switch (vals.length) {
        case 1:
            bytes = [(vals[0] >>> 24) & 0xff, (vals[0] >>> 16) & 0xff, (vals[0] >>> 8) & 0xff, vals[0] & 0xff];
            break;
        case 2: // a.(24-bit)
            if (vals[0] > 0xff || vals[1] > 0xffffff) return INADDR_NONE;
            bytes = [vals[0], (vals[1] >>> 16) & 0xff, (vals[1] >>> 8) & 0xff, vals[1] & 0xff];
            break;
        case 3: // a.b.(16-bit)
            if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xffff) return INADDR_NONE;
            bytes = [vals[0], vals[1], (vals[2] >>> 8) & 0xff, vals[2] & 0xff];
            break;
        default: // a.b.c.d
            if (vals.some((v) => v > 0xff)) return INADDR_NONE;
            bytes = [vals[0], vals[1], vals[2], vals[3]];
            break;
    }
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/** `inet_addr(const char* cp)` thunk — reads the dotted string and parses it (see parseInetAddr). */
export const inetAddr: ThunkImplementation = (_ctx, mem, args) => {
    const ptr = (args[0] ?? 0) >>> 0;
    if (ptr === 0) return 0xffffffff;
    return parseInetAddr(Marshaler.readString(mem as Uint8Array, ptr));
};

export const WSADATA_SIZE = 0x190;
const WSADATA_DESC_OFF = 4;
const WSADATA_STATUS_OFF = 261;
const WSADATA_IMAXSOCKETS_OFF = 390;
const WSADATA_IMAXUDPDG_OFF = 392;
const WSADATA_LPVENDORINFO_OFF = 394;

/** Negotiate Winsock version for stub (1.1 or 2.2). */
export function negotiateWsaVersion(wVersionRequested: number): { wVersion: number; wHighVersion: number } {
    const req = wVersionRequested & 0xffff;
    const lo = req & 0xff;
    if (lo >= 2) {
        return { wVersion: 0x0202, wHighVersion: 0x0202 };
    }
    return { wVersion: 0x0101, wHighVersion: 0x0101 };
}

function writeU16(mem: Uint8Array | null, addr: number, value: number): boolean {
    if (mem) {
        if (addr < 0 || addr + 2 > mem.length) return false;
        mem[addr] = value & 0xff;
        mem[addr + 1] = (value >>> 8) & 0xff;
        return true;
    }
    return Mem.writeUint16(addr, value);
}

function writeBytes(mem: Uint8Array | null, addr: number, bytes: Uint8Array): boolean {
    if (mem) {
        if (addr < 0 || addr + bytes.length > mem.length) return false;
        mem.set(bytes, addr);
        return true;
    }
    return Mem.writeBytes(addr, bytes) === bytes.length;
}

function writeU32(mem: Uint8Array | null, addr: number, value: number): boolean {
    if (mem) {
        if (addr < 0 || addr + 4 > mem.length) return false;
        mem[addr] = value & 0xff;
        mem[addr + 1] = (value >>> 8) & 0xff;
        mem[addr + 2] = (value >>> 16) & 0xff;
        mem[addr + 3] = (value >>> 24) & 0xff;
        return true;
    }
    return Mem.writeUint32(addr, value);
}

/** Fill WSADATA — required by MFC/HL after WSAStartup returns 0. */
export function writeWsaData(lpWSAData: number, wVersionRequested: number, mem: Uint8Array | null = null): boolean {
    if (!lpWSAData) return false;

    const { wVersion, wHighVersion } = negotiateWsaVersion(wVersionRequested);
    if (!writeU16(mem, lpWSAData, wVersion) || !writeU16(mem, lpWSAData + 2, wHighVersion)) {
        return false;
    }

    const desc = new Uint8Array(257);
    desc.set(new TextEncoder().encode("BottleShip Winsock stub\0").subarray(0, 256));
    const status = new Uint8Array(129);
    status.set(new TextEncoder().encode("Running\0").subarray(0, 128));

    if (!writeBytes(mem, lpWSAData + WSADATA_DESC_OFF, desc)) return false;
    if (!writeBytes(mem, lpWSAData + WSADATA_STATUS_OFF, status)) return false;
    if (!writeU16(mem, lpWSAData + WSADATA_IMAXSOCKETS_OFF, 32)) return false;
    if (!writeU16(mem, lpWSAData + WSADATA_IMAXUDPDG_OFF, 32)) return false;
    if (!writeU32(mem, lpWSAData + WSADATA_LPVENDORINFO_OFF, 0)) return false;
    return true;
}

/** Minimum sockaddr_in size on Win32. */
export const SOCKADDR_IN_SIZE = 16;
const AF_INET = 2;
/** 127.0.0.1 in network byte order. */
const INADDR_LOOPBACK = 0x0100007f;

/** Write a loopback IPv4 sockaddr_in at `addr`. */
export function writeSockaddrInLoopback(addr: number, portHostOrder: number, mem: Uint8Array | null): boolean {
    if (!addr) return false;
    const port = ((portHostOrder & 0xff) << 8) | ((portHostOrder >>> 8) & 0xff);
    if (!writeU16(mem, addr, AF_INET)) return false;
    if (!writeU16(mem, addr + 2, port)) return false;
    if (!writeU32(mem, addr + 4, INADDR_LOOPBACK)) return false;
    if (mem) {
        if (addr + 8 + 8 > mem.length) return false;
        mem.fill(0, addr + 8, addr + 16);
        return true;
    }
    return Mem.writeBytes(addr + 8, new Uint8Array(8)) === 8;
}

const LOOPBACK_HOST_NAME = "localhost";
const LOOPBACK_ADDR_BYTES = new Uint8Array([127, 0, 0, 1]);

export interface DnsStubs {
    gethostbyname: ThunkImplementation;
    gethostbyaddr: ThunkImplementation;
    gethostname: ThunkImplementation;
    inetNtoa: ThunkImplementation;
}

/**
 * Deterministic offline DNS: any hostname/address probe resolves to a loopback hostent
 * (no real network in this stub), so callers never dereference NULL. Shared by wsock32
 * and ws2_32 so both DLLs answer identically instead of drifting.
 */
export function createDnsStubs(process: Process, setLastError: (code: number) => void): DnsStubs {
    let hostentAddr = 0;
    let inetNtoaBufAddr = 0;

    const ensureLoopbackHostent = (): number => {
        if (hostentAddr) return hostentAddr;

        // hostent:
        //  +0 h_name      (char*)
        //  +4 h_aliases   (char**)
        //  +8 h_addrtype  (short)
        // +10 h_length    (short)
        // +12 h_addr_list (char**)
        const hNameAddr = process.memory.alloc(LOOPBACK_HOST_NAME.length + 1, "THUNK_DATA", "rw");
        const hAliasesAddr = process.memory.alloc(4, "THUNK_DATA", "rw");   // [NULL]
        const hAddrBytesAddr = process.memory.alloc(4, "THUNK_DATA", "rw"); // 127.0.0.1
        const hAddrListAddr = process.memory.alloc(8, "THUNK_DATA", "rw");  // [ptr, NULL]
        const hEntAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
        if (!hNameAddr || !hAliasesAddr || !hAddrBytesAddr || !hAddrListAddr || !hEntAddr) {
            setLastError(WSAENETDOWN);
            return 0;
        }

        const nameBytes = new TextEncoder().encode(`${LOOPBACK_HOST_NAME}\0`);
        if (Mem.writeBytes(hNameAddr, nameBytes) !== nameBytes.length) { setLastError(WSAENETDOWN); return 0; }
        if (!Mem.writeUint32(hAliasesAddr, 0)) { setLastError(WSAENETDOWN); return 0; }
        if (Mem.writeBytes(hAddrBytesAddr, LOOPBACK_ADDR_BYTES) !== LOOPBACK_ADDR_BYTES.length) {
            setLastError(WSAENETDOWN);
            return 0;
        }
        if (!Mem.writeUint32(hAddrListAddr, hAddrBytesAddr) || !Mem.writeUint32(hAddrListAddr + 4, 0)) {
            setLastError(WSAENETDOWN);
            return 0;
        }
        if (!Mem.writeUint32(hEntAddr, hNameAddr) ||
            !Mem.writeUint32(hEntAddr + 4, hAliasesAddr) ||
            Mem.writeBytes(hEntAddr + 8, new Uint8Array([AF_INET, 0, 4, 0])) !== 4 ||
            !Mem.writeUint32(hEntAddr + 12, hAddrListAddr)) {
            setLastError(WSAENETDOWN);
            return 0;
        }

        hostentAddr = hEntAddr >>> 0;
        return hostentAddr;
    };

    const ensureInetNtoaBuffer = (): number => {
        if (inetNtoaBufAddr) return inetNtoaBufAddr;
        const addr = process.memory.alloc(16, "THUNK_DATA", "rw"); // "255.255.255.255\0"
        if (!addr) { setLastError(WSAENETDOWN); return 0; }
        inetNtoaBufAddr = addr >>> 0;
        return inetNtoaBufAddr;
    };

    const gethostname: ThunkImplementation = (_ctx, _mem, args) => {
        const namePtr = args[0] >>> 0;
        const len = (args[1] ?? 0) | 0;
        if (!namePtr || len <= 0) { setLastError(WSAEFAULT); return SOCKET_ERROR; }

        const maxWrite = Math.max(0, len - 1);
        const hostBytes = new TextEncoder().encode(LOOPBACK_HOST_NAME);
        const toCopy = hostBytes.subarray(0, Math.min(hostBytes.length, maxWrite));
        if (toCopy.length > 0 && Mem.writeBytes(namePtr, toCopy) !== toCopy.length) {
            setLastError(WSAEFAULT);
            return SOCKET_ERROR;
        }
        if (Mem.writeBytes(namePtr + toCopy.length, new Uint8Array([0])) !== 1) {
            setLastError(WSAEFAULT);
            return SOCKET_ERROR;
        }

        setLastError(0);
        return 0;
    };

    const gethostbyname: ThunkImplementation = (_ctx, mem, args) => {
        const namePtr = args[0] >>> 0;
        if (!namePtr) { setLastError(WSAEFAULT); return 0; }

        const name = Marshaler.readString(mem, namePtr).trim();
        if (!name) { setLastError(WSAHOST_NOT_FOUND); return 0; }

        const ptr = ensureLoopbackHostent();
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    const gethostbyaddr: ThunkImplementation = (_ctx, _mem, args) => {
        const addrPtr = args[0] >>> 0;
        const len = (args[1] ?? 0) | 0;
        const addrType = (args[2] ?? 0) | 0;
        if (!addrPtr || len < 4 || addrType !== AF_INET) { setLastError(WSAHOST_NOT_FOUND); return 0; }

        const ptr = ensureLoopbackHostent();
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    const inetNtoa: ThunkImplementation = (_ctx, _mem, args) => {
        const addrValue = args[0] >>> 0;
        const target = ensureInetNtoaBuffer();
        if (!target) { setLastError(WSAENETDOWN); return 0; }

        // in_addr is passed by value; bytes are already in network order.
        const a = addrValue & 0xff;
        const b = (addrValue >>> 8) & 0xff;
        const c = (addrValue >>> 16) & 0xff;
        const d = (addrValue >>> 24) & 0xff;
        const bytes = new TextEncoder().encode(`${a}.${b}.${c}.${d}\0`);
        if (Mem.writeBytes(target, bytes) !== bytes.length) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return target;
    };

    return { gethostbyname, gethostbyaddr, gethostname, inetNtoa };
}

interface ProtoEntry {
    name: string;
    number: number;
}

/** Well-known IANA protocol numbers (RFC 1700) — a small generic /etc/protocols-equivalent. */
const KNOWN_PROTOCOLS: ProtoEntry[] = [
    { name: "ip", number: 0 },
    { name: "icmp", number: 1 },
    { name: "tcp", number: 6 },
    { name: "udp", number: 17 },
];

interface ServEntry {
    name: string;
    port: number; // host byte order
    proto: "tcp" | "udp";
}

/** Well-known IANA service ports — a small generic /etc/services-equivalent. */
const KNOWN_SERVICES: ServEntry[] = [
    { name: "echo", port: 7, proto: "tcp" },
    { name: "echo", port: 7, proto: "udp" },
    { name: "ftp", port: 21, proto: "tcp" },
    { name: "telnet", port: 23, proto: "tcp" },
    { name: "smtp", port: 25, proto: "tcp" },
    { name: "domain", port: 53, proto: "tcp" },
    { name: "domain", port: 53, proto: "udp" },
    { name: "http", port: 80, proto: "tcp" },
    { name: "pop3", port: 110, proto: "tcp" },
    { name: "https", port: 443, proto: "tcp" },
];

export interface ProtoServStubs {
    getprotobyname: ThunkImplementation;
    getprotobynumber: ThunkImplementation;
    getservbyname: ThunkImplementation;
    getservbyport: ThunkImplementation;
}

/**
 * getprotobyname/getprotobynumber/getservbyname/getservbyport — per real Winsock semantics
 * these return a pointer to a buffer owned by the DLL that is overwritten on the next call
 * (not caller-allocated), so one reused scratch region per entry family is faithful, not a
 * shortcut.
 */
export function createProtoServStubs(process: Process, setLastError: (code: number) => void): ProtoServStubs {
    let protoBufAddr = 0;
    let servBufAddr = 0;
    const PROTOENT_SCRATCH = 64;
    const SERVENT_SCRATCH = 96;

    const ensureProtoBuf = (): number => {
        if (protoBufAddr) return protoBufAddr;
        const addr = process.memory.alloc(PROTOENT_SCRATCH, "THUNK_DATA", "rw");
        if (addr) protoBufAddr = addr >>> 0;
        return protoBufAddr;
    };
    const ensureServBuf = (): number => {
        if (servBufAddr) return servBufAddr;
        const addr = process.memory.alloc(SERVENT_SCRATCH, "THUNK_DATA", "rw");
        if (addr) servBufAddr = addr >>> 0;
        return servBufAddr;
    };

    // protoent: +0 p_name(char*) +4 p_aliases(char**) +8 p_proto(short); struct size 12 (padded).
    const packProtoent = (entry: ProtoEntry): number => {
        const base = ensureProtoBuf();
        if (!base) return 0;
        const nameAddr = base + 16;
        const aliasesAddr = base + 40;
        const nameBytes = new TextEncoder().encode(`${entry.name}\0`);
        if (nameBytes.length > aliasesAddr - nameAddr) return 0; // scratch sizing guard
        if (Mem.writeBytes(nameAddr, nameBytes) !== nameBytes.length) return 0;
        if (!Mem.writeUint32(aliasesAddr, 0)) return 0;
        if (!Mem.writeUint32(base, nameAddr) || !Mem.writeUint32(base + 4, aliasesAddr) ||
            !Mem.writeUint16(base + 8, entry.number)) return 0;
        return base;
    };

    // servent: +0 s_name(char*) +4 s_aliases(char**) +8 s_port(short,net order) +12 s_proto(char*);
    // struct size 16 (2-byte pad after s_port to keep s_proto 4-byte aligned).
    const packServent = (entry: ServEntry): number => {
        const base = ensureServBuf();
        if (!base) return 0;
        const nameAddr = base + 16;
        const protoAddr = base + 40;
        const aliasesAddr = base + 48;
        const nameBytes = new TextEncoder().encode(`${entry.name}\0`);
        const protoBytes = new TextEncoder().encode(`${entry.proto}\0`);
        if (nameBytes.length > protoAddr - nameAddr || protoBytes.length > aliasesAddr - protoAddr) return 0;
        if (Mem.writeBytes(nameAddr, nameBytes) !== nameBytes.length) return 0;
        if (Mem.writeBytes(protoAddr, protoBytes) !== protoBytes.length) return 0;
        if (!Mem.writeUint32(aliasesAddr, 0)) return 0;
        const netPort = ((entry.port & 0xff) << 8) | ((entry.port >>> 8) & 0xff);
        if (!Mem.writeUint32(base, nameAddr) || !Mem.writeUint32(base + 4, aliasesAddr) ||
            !Mem.writeUint16(base + 8, netPort) || !Mem.writeUint32(base + 12, protoAddr)) return 0;
        return base;
    };

    const getprotobyname: ThunkImplementation = (_ctx, mem, args) => {
        const namePtr = args[0] >>> 0;
        if (!namePtr) { setLastError(WSAEFAULT); return 0; }
        const name = Marshaler.readString(mem, namePtr).trim().toLowerCase();
        const entry = KNOWN_PROTOCOLS.find((p) => p.name === name);
        if (!entry) { setLastError(WSANO_DATA); return 0; }
        const ptr = packProtoent(entry);
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    const getprotobynumber: ThunkImplementation = (_ctx, _mem, args) => {
        const number = (args[0] ?? 0) | 0;
        const entry = KNOWN_PROTOCOLS.find((p) => p.number === number);
        if (!entry) { setLastError(WSANO_DATA); return 0; }
        const ptr = packProtoent(entry);
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    const getservbyname: ThunkImplementation = (_ctx, mem, args) => {
        const namePtr = args[0] >>> 0;
        const protoPtr = args[1] >>> 0;
        if (!namePtr) { setLastError(WSAEFAULT); return 0; }
        const name = Marshaler.readString(mem, namePtr).trim().toLowerCase();
        const proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        const entry = KNOWN_SERVICES.find((s) => s.name === name && (!proto || s.proto === proto));
        if (!entry) { setLastError(WSANO_DATA); return 0; }
        const ptr = packServent(entry);
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    const getservbyport: ThunkImplementation = (_ctx, mem, args) => {
        const netPort = (args[0] ?? 0) & 0xffff;
        const hostPort = ((netPort & 0xff) << 8) | ((netPort >>> 8) & 0xff);
        const protoPtr = args[1] >>> 0;
        const proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        const entry = KNOWN_SERVICES.find((s) => s.port === hostPort && (!proto || s.proto === proto));
        if (!entry) { setLastError(WSANO_DATA); return 0; }
        const ptr = packServent(entry);
        if (!ptr) { setLastError(WSAENETDOWN); return 0; }
        setLastError(0);
        return ptr;
    };

    return { getprotobyname, getprotobynumber, getservbyname, getservbyport };
}

export interface AddrInfoStubs {
    getaddrinfo: ThunkImplementation;
    freeaddrinfo: ThunkImplementation;
    getnameinfo: ThunkImplementation;
    /** Game switch: the guest address space is rewound, so a chain recorded against the old
     *  one would let a later free hand a recycled address back to the allocator. */
    reset: () => void;
}

/**
 * addrinfo (32-bit): +0 ai_flags +4 ai_family +8 ai_socktype +12 ai_protocol
 *                   +16 ai_addrlen +20 ai_canonname(char*) +24 ai_addr(sockaddr*) +28 ai_next
 */
const ADDRINFO_SIZE = 32;
const AI_PASSIVE = 0x01;
const AI_CANONNAME = 0x02;
const AI_NUMERICHOST = 0x04;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;
const AF_UNSPEC = 0;
/** getaddrinfo error codes double as WSA errors on Windows (ws2tcpip.h). */
const EAI_NONAME = 11001;   // WSAHOST_NOT_FOUND
const EAI_SERVICE = 10109;   // WSATYPE_NOT_FOUND
const EAI_FAMILY = 10047;    // WSAEAFNOSUPPORT
const EAI_MEMORY = 10055;    // WSAENOBUFS
const EAI_FAIL = 11003;      // WSANO_RECOVERY
const NI_NUMERICHOST = 0x02;
const NI_NUMERICSERV = 0x08;
const NI_NAMEREQD = 0x04;

/**
 * getaddrinfo / freeaddrinfo / getnameinfo — the ws2tcpip resolver over the same offline
 * name space the hostent stubs answer from (see createDnsStubs), so both spellings of "look
 * this name up" agree instead of one succeeding and the other failing. A NULL node with
 * AI_PASSIVE is INADDR_ANY (the bind case) and without it loopback, exactly as documented;
 * anything else resolves to loopback.
 *
 * The result chain is allocated in guest memory and owned by us until freeaddrinfo — the
 * caller must not free it itself, so a per-call allocation set is tracked and released as a
 * unit. A dangling free (an addrinfo we never handed out) is ignored, matching the DLL's own
 * tolerance rather than corrupting the heap.
 */
export function createAddrInfoStubs(process: Process, setLastError: (code: number) => void): AddrInfoStubs {
    /** head addrinfo -> every guest block allocated for that chain, in allocation order. */
    const chains = new Map<number, number[]>();

    const parsePort = (service: string, hints: { socktype: number }): number | null => {
        if (!service) return 0;
        if (/^[0-9]+$/.test(service)) {
            const p = parseInt(service, 10);
            return p >= 0 && p <= 0xffff ? p : null;
        }
        const proto = hints.socktype === SOCK_DGRAM ? "udp" : hints.socktype === SOCK_STREAM ? "tcp" : "";
        const entry = KNOWN_SERVICES.find((s) => s.name === service.toLowerCase() && (!proto || s.proto === proto));
        return entry ? entry.port : null;
    };

    const getaddrinfo: ThunkImplementation = (_ctx, mem, args) => {
        const nodePtr = args[0] >>> 0;
        const servicePtr = args[1] >>> 0;
        const hintsPtr = args[2] >>> 0;
        const resultPtr = args[3] >>> 0;
        if (!resultPtr) { setLastError(WSAEFAULT); return WSAEFAULT; }

        let flags = 0, family = AF_UNSPEC, socktype = 0, protocol = 0;
        if (hintsPtr) {
            flags = (Mem.readUint32(hintsPtr) ?? 0) >>> 0;
            family = (Mem.readUint32(hintsPtr + 4) ?? 0) | 0;
            socktype = (Mem.readUint32(hintsPtr + 8) ?? 0) | 0;
            protocol = (Mem.readUint32(hintsPtr + 12) ?? 0) | 0;
        }
        if (family !== AF_UNSPEC && family !== AF_INET) { setLastError(EAI_FAMILY); return EAI_FAMILY; }

        const node = nodePtr ? Marshaler.readString(mem, nodePtr).trim() : "";
        const service = servicePtr ? Marshaler.readString(mem, servicePtr).trim() : "";
        const port = parsePort(service, { socktype });
        if (port === null) { setLastError(EAI_SERVICE); return EAI_SERVICE; }

        // A numeric node keeps its literal address; a name resolves to loopback (offline).
        let addr: number;
        if (node) {
            const literal = parseInetAddr(node);
            if (literal !== 0xffffffff) addr = literal;
            else if (flags & AI_NUMERICHOST) { setLastError(EAI_NONAME); return EAI_NONAME; }
            else addr = INADDR_LOOPBACK;
        } else if (!servicePtr) {
            // Both node and service NULL is the one input getaddrinfo rejects outright.
            setLastError(EAI_NONAME);
            return EAI_NONAME;
        } else {
            addr = (flags & AI_PASSIVE) ? 0 : INADDR_LOOPBACK;
        }

        // With no socktype hint, real Windows returns one addrinfo per socket type.
        const kinds: Array<{ socktype: number; protocol: number }> = socktype
            ? [{ socktype, protocol: protocol || (socktype === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP) }]
            : [{ socktype: SOCK_STREAM, protocol: IPPROTO_TCP }, { socktype: SOCK_DGRAM, protocol: IPPROTO_UDP }];

        const owned: number[] = [];
        const grab = (size: number): number => {
            const p = process.memory.alloc(size, "THUNK_DATA", "rw");
            if (p) owned.push(p >>> 0);
            return (p ?? 0) >>> 0;
        };
        const abort = (code: number): number => {
            for (const p of owned) process.memory.free(p);
            setLastError(code);
            return code;
        };

        let canonAddr = 0;
        if (flags & AI_CANONNAME) {
            const canon = node || LOOPBACK_HOST_NAME;
            const bytes = new TextEncoder().encode(`${canon}\0`);
            canonAddr = grab(bytes.length);
            if (!canonAddr || Mem.writeBytes(canonAddr, bytes) !== bytes.length) return abort(EAI_MEMORY);
        }

        let head = 0, prev = 0;
        for (const kind of kinds) {
            const sa = grab(SOCKADDR_IN_SIZE);
            const ai = grab(ADDRINFO_SIZE);
            if (!sa || !ai) return abort(EAI_MEMORY);
            // sockaddr_in: +0 sin_family +2 sin_port(net) +4 sin_addr +8 sin_zero[8]
            const netPort = ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
            if (!Mem.writeUint16(sa, AF_INET) || !Mem.writeUint16(sa + 2, netPort) ||
                !Mem.writeUint32(sa + 4, addr) ||
                !Mem.writeUint32(sa + 8, 0) || !Mem.writeUint32(sa + 12, 0)) return abort(EAI_FAIL);
            if (!Mem.writeUint32(ai, flags) || !Mem.writeUint32(ai + 4, AF_INET) ||
                !Mem.writeUint32(ai + 8, kind.socktype) || !Mem.writeUint32(ai + 12, kind.protocol) ||
                !Mem.writeUint32(ai + 16, SOCKADDR_IN_SIZE) ||
                // ai_canonname is set on the FIRST result only, per the documented contract.
                !Mem.writeUint32(ai + 20, prev ? 0 : canonAddr) ||
                !Mem.writeUint32(ai + 24, sa) || !Mem.writeUint32(ai + 28, 0)) return abort(EAI_FAIL);
            if (prev) { if (!Mem.writeUint32(prev + 28, ai)) return abort(EAI_FAIL); } else head = ai;
            prev = ai;
        }

        if (!Mem.writeUint32(resultPtr, head)) return abort(WSAEFAULT);
        chains.set(head, owned);
        setLastError(0);
        return 0;
    };

    const freeaddrinfo: ThunkImplementation = (_ctx, _mem, args) => {
        const head = args[0] >>> 0;
        const owned = chains.get(head);
        if (!owned) return 0;
        chains.delete(head);
        for (const p of owned) process.memory.free(p);
        return 0;
    };

    const getnameinfo: ThunkImplementation = (_ctx, _mem, args) => {
        const saPtr = args[0] >>> 0;
        const saLen = (args[1] ?? 0) | 0;
        const hostPtr = args[2] >>> 0;
        const hostLen = (args[3] ?? 0) >>> 0;
        const servPtr = args[4] >>> 0;
        const servLen = (args[5] ?? 0) >>> 0;
        const flags = (args[6] ?? 0) >>> 0;
        if (!saPtr || saLen < SOCKADDR_IN_SIZE) { setLastError(WSAEFAULT); return WSAEFAULT; }
        if ((Mem.readUint16(saPtr) ?? 0) !== AF_INET) { setLastError(EAI_FAMILY); return EAI_FAMILY; }

        const netPort = (Mem.readUint16(saPtr + 2) ?? 0) >>> 0;
        const port = ((netPort & 0xff) << 8) | ((netPort >>> 8) & 0xff);
        const a = (Mem.readUint32(saPtr + 4) ?? 0) >>> 0;
        const dotted = `${a & 0xff}.${(a >>> 8) & 0xff}.${(a >>> 16) & 0xff}.${(a >>> 24) & 0xff}`;

        const write = (text: string, ptr: number, len: number): boolean => {
            if (!ptr || len === 0) return true;
            const bytes = new TextEncoder().encode(`${text}\0`);
            if (bytes.length > len) return false;
            return Mem.writeBytes(ptr, bytes) === bytes.length;
        };

        if (hostPtr && hostLen) {
            // Only loopback has a name offline; NI_NAMEREQD must fail rather than hand back a literal.
            const named = !(flags & NI_NUMERICHOST) && a === INADDR_LOOPBACK;
            if (!named && (flags & NI_NAMEREQD)) { setLastError(EAI_NONAME); return EAI_NONAME; }
            if (!write(named ? LOOPBACK_HOST_NAME : dotted, hostPtr, hostLen)) {
                setLastError(WSAEFAULT);
                return WSAEFAULT;
            }
        }
        if (servPtr && servLen) {
            const entry = (flags & NI_NUMERICSERV) ? undefined : KNOWN_SERVICES.find((s) => s.port === port);
            if (!write(entry ? entry.name : String(port), servPtr, servLen)) {
                setLastError(WSAEFAULT);
                return WSAEFAULT;
            }
        }
        setLastError(0);
        return 0;
    };

    return { getaddrinfo, freeaddrinfo, getnameinfo, reset: () => chains.clear() };
}

/** fd_set: +0 fd_count(u_int) +4 fd_array[fd_count] (SOCKET, 4 bytes each on 32-bit). */
function parseFdSet(mem: Uint8Array, ptr: number): number[] {
    if (!ptr) return [];
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const count = view.getUint32(ptr, true);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
        out.push(view.getUint32(ptr + 4 + i * 4, true) >>> 0);
    }
    return out;
}

function writeFdSetSockets(mem: Uint8Array, ptr: number, sockets: number[]): boolean {
    if (!ptr) return true;
    if (!writeU32(mem, ptr, sockets.length)) return false;
    for (let i = 0; i < sockets.length; i++) {
        if (!writeU32(mem, ptr + 4 + i * 4, sockets[i])) return false;
    }
    return true;
}

/**
 * select(nfds, readfds, writefds, exceptfds, timeout) — nfds is ignored (BSD source
 * compatibility only, per Winsock docs). This offline stub never has inbound data or OOB
 * data pending (mirrors recv/recvfrom always failing — see WsaSocketTable), but a connected
 * socket is always ready to write (mirrors connect() completing synchronously). A socket
 * that isn't valid in any supplied set is a WSAENOTSOCK error for the whole call, per spec.
 */
export function makeSelect(table: WsaSocketTable, setLastError: (code: number) => void): ThunkImplementation {
    return (_ctx, mem, args) => {
        const readfdsPtr = args[1] >>> 0;
        const writefdsPtr = args[2] >>> 0;
        const exceptfdsPtr = args[3] >>> 0;

        const readSockets = parseFdSet(mem, readfdsPtr);
        const writeSockets = parseFdSet(mem, writefdsPtr);
        const exceptSockets = parseFdSet(mem, exceptfdsPtr);

        for (const s of [...readSockets, ...writeSockets, ...exceptSockets]) {
            if (!table.isValid(s)) {
                setLastError(WSAENOTSOCK);
                return SOCKET_ERROR;
            }
        }

        const readyWrite = writeSockets.filter((s) => table.isConnected(s));

        if (!writeFdSetSockets(mem, readfdsPtr, []) ||
            !writeFdSetSockets(mem, writefdsPtr, readyWrite) ||
            !writeFdSetSockets(mem, exceptfdsPtr, [])) {
            setLastError(WSAEFAULT);
            return SOCKET_ERROR;
        }

        setLastError(0);
        return readyWrite.length;
    };
}

/** __WSAFDIsSet(s, fd_set*) — BOOL membership test used by the FD_ISSET() macro. */
export function makeFdIsSet(): ThunkImplementation {
    return (_ctx, mem, args) => {
        const s = args[0] >>> 0;
        const setPtr = args[1] >>> 0;
        return parseFdSet(mem, setPtr).includes(s) ? 1 : 0;
    };
}

/** Pack a hostent + its referenced name/alias/address data entirely inside a caller buffer.
 *  Unlike the sync gethostbyname (shared static buffer), WSAAsyncGetHostByXxx must fit
 *  everything into the single `buf`/`buflen` the caller supplies. Returns bytes used, or -1
 *  if buf is too small (caller maps that to WSAENOBUFS). */
function packHostentInto(mem: Uint8Array, buf: number, buflen: number, name: string, addrBytes: Uint8Array): number {
    const HOSTENT_SIZE = 16;
    const nameBytes = new TextEncoder().encode(`${name}\0`);
    const nameOff = HOSTENT_SIZE;
    const aliasesOff = nameOff + nameBytes.length;
    const addrBytesOff = aliasesOff + 4;
    const addrListOff = addrBytesOff + addrBytes.length;
    const total = addrListOff + 8;
    if (!buf || total > buflen) return -1;

    const nameAddr = buf + nameOff;
    const aliasesAddr = buf + aliasesOff;
    const addrBytesAddr = buf + addrBytesOff;
    const addrListAddr = buf + addrListOff;
    if (!writeBytes(mem, nameAddr, nameBytes)) return -1;
    if (!writeU32(mem, aliasesAddr, 0)) return -1;
    if (!writeBytes(mem, addrBytesAddr, addrBytes)) return -1;
    if (!writeU32(mem, addrListAddr, addrBytesAddr) || !writeU32(mem, addrListAddr + 4, 0)) return -1;
    if (!writeU32(mem, buf, nameAddr) || !writeU32(mem, buf + 4, aliasesAddr) ||
        !writeBytes(mem, buf + 8, new Uint8Array([AF_INET, 0, addrBytes.length & 0xff, 0])) ||
        !writeU32(mem, buf + 12, addrListAddr)) return -1;
    return total;
}

/** Pack a protoent entirely inside a caller buffer (see packHostentInto). */
function packProtoentInto(mem: Uint8Array, buf: number, buflen: number, entry: ProtoEntry): number {
    const STRUCT_SIZE = 12;
    const nameBytes = new TextEncoder().encode(`${entry.name}\0`);
    const nameOff = STRUCT_SIZE;
    const aliasesOff = nameOff + nameBytes.length;
    const total = aliasesOff + 4;
    if (!buf || total > buflen) return -1;

    const nameAddr = buf + nameOff;
    const aliasesAddr = buf + aliasesOff;
    if (!writeBytes(mem, nameAddr, nameBytes)) return -1;
    if (!writeU32(mem, aliasesAddr, 0)) return -1;
    if (!writeU32(mem, buf, nameAddr) || !writeU32(mem, buf + 4, aliasesAddr) ||
        !writeU16(mem, buf + 8, entry.number)) return -1;
    return total;
}

/** Pack a servent entirely inside a caller buffer (see packHostentInto). */
function packServentInto(mem: Uint8Array, buf: number, buflen: number, entry: ServEntry): number {
    const STRUCT_SIZE = 16;
    const nameBytes = new TextEncoder().encode(`${entry.name}\0`);
    const protoBytes = new TextEncoder().encode(`${entry.proto}\0`);
    const nameOff = STRUCT_SIZE;
    const protoOff = nameOff + nameBytes.length;
    const aliasesOff = protoOff + protoBytes.length;
    const total = aliasesOff + 4;
    if (!buf || total > buflen) return -1;

    const nameAddr = buf + nameOff;
    const protoAddr = buf + protoOff;
    const aliasesAddr = buf + aliasesOff;
    if (!writeBytes(mem, nameAddr, nameBytes)) return -1;
    if (!writeBytes(mem, protoAddr, protoBytes)) return -1;
    if (!writeU32(mem, aliasesAddr, 0)) return -1;
    const netPort = ((entry.port & 0xff) << 8) | ((entry.port >>> 8) & 0xff);
    if (!writeU32(mem, buf, nameAddr) || !writeU32(mem, buf + 4, aliasesAddr) ||
        !writeU16(mem, buf + 8, netPort) || !writeU32(mem, buf + 12, protoAddr)) return -1;
    return total;
}

let nextAsyncTaskHandle = 1;

/** Task handles just need to be a nonzero, caller-opaque token — real apps only ever pass
 *  them back to WSACancelAsyncRequest or compare against the WM_* message's wParam. */
function makeAsyncTaskHandle(): number {
    const handle = nextAsyncTaskHandle++;
    if (nextAsyncTaskHandle > 0x7fffffff) nextAsyncTaskHandle = 1;
    return handle;
}

/** Post a WSAAsyncGetXxx completion. lParam packs WSAGETASYNCBUFLEN (low word) / error
 *  WSAGETASYNCERROR (high word), matching the documented MAKELPARAM(buflen, error). */
function postAsyncLookupCompletion(hWnd: number, wMsg: number, task: number, bytesUsed: number, error: number): void {
    if (!hWnd || !wMsg) return;
    const system = System.getInstance();
    const lParam = (((error & 0xffff) << 16) | (bytesUsed & 0xffff)) >>> 0;
    system.windowManager.postMessage(hWnd, wMsg, task >>> 0, lParam);
    system.scheduler.wakeMessageWaiters();
}

export interface AsyncLookupStubs {
    WSAAsyncGetHostByName: ThunkImplementation;
    WSAAsyncGetHostByAddr: ThunkImplementation;
    WSAAsyncGetProtoByName: ThunkImplementation;
    WSAAsyncGetProtoByNumber: ThunkImplementation;
    WSAAsyncGetServByName: ThunkImplementation;
    WSAAsyncGetServByPort: ThunkImplementation;
}

/**
 * WSAAsyncGetXxx — real Winsock always hands back a nonzero task handle immediately and
 * defers success/failure to a posted window message (WSAGETASYNCERROR(lParam)); it only
 * returns 0 when the request couldn't even be queued. Since this stub's lookups are all
 * local/instant (see createDnsStubs/createProtoServStubs), "queued" means "resolved before
 * this call returns" — the completion message is posted right away rather than never sent,
 * which is what the previous always-fail stubs did (task handle 0 => caller treats it as an
 * immediate startup failure instead of draining the real error via the message).
 */
export function createAsyncLookupStubs(setLastError: (code: number) => void): AsyncLookupStubs {
    const WSAAsyncGetHostByName: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const namePtr = args[2] >>> 0;
        const buf = args[3] >>> 0;
        const buflen = (args[4] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        const name = namePtr ? Marshaler.readString(mem, namePtr).trim() : "";
        let bytes = 0;
        let error = 0;
        if (!name) {
            error = WSAHOST_NOT_FOUND;
        } else {
            bytes = packHostentInto(mem, buf, buflen, LOOPBACK_HOST_NAME, LOOPBACK_ADDR_BYTES);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    const WSAAsyncGetHostByAddr: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const addrPtr = args[2] >>> 0;
        const len = (args[3] ?? 0) | 0;
        const addrType = (args[4] ?? 0) | 0;
        const buf = args[5] >>> 0;
        const buflen = (args[6] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        let bytes = 0;
        let error = 0;
        if (!addrPtr || len < 4 || addrType !== AF_INET) {
            error = WSAHOST_NOT_FOUND;
        } else {
            bytes = packHostentInto(mem, buf, buflen, LOOPBACK_HOST_NAME, LOOPBACK_ADDR_BYTES);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    const WSAAsyncGetProtoByName: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const namePtr = args[2] >>> 0;
        const buf = args[3] >>> 0;
        const buflen = (args[4] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        const name = namePtr ? Marshaler.readString(mem, namePtr).trim().toLowerCase() : "";
        const entry = KNOWN_PROTOCOLS.find((p) => p.name === name);
        let bytes = 0;
        let error = 0;
        if (!entry) {
            error = WSANO_DATA;
        } else {
            bytes = packProtoentInto(mem, buf, buflen, entry);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    const WSAAsyncGetProtoByNumber: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const number = (args[2] ?? 0) | 0;
        const buf = args[3] >>> 0;
        const buflen = (args[4] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        const entry = KNOWN_PROTOCOLS.find((p) => p.number === number);
        let bytes = 0;
        let error = 0;
        if (!entry) {
            error = WSANO_DATA;
        } else {
            bytes = packProtoentInto(mem, buf, buflen, entry);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    const WSAAsyncGetServByName: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const namePtr = args[2] >>> 0;
        const protoPtr = args[3] >>> 0;
        const buf = args[4] >>> 0;
        const buflen = (args[5] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        const name = namePtr ? Marshaler.readString(mem, namePtr).trim().toLowerCase() : "";
        const proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        const entry = KNOWN_SERVICES.find((s) => s.name === name && (!proto || s.proto === proto));
        let bytes = 0;
        let error = 0;
        if (!entry) {
            error = WSANO_DATA;
        } else {
            bytes = packServentInto(mem, buf, buflen, entry);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    const WSAAsyncGetServByPort: ThunkImplementation = (_ctx, mem, args) => {
        const hWnd = args[0] >>> 0;
        const wMsg = args[1] >>> 0;
        const netPort = (args[2] ?? 0) & 0xffff;
        const protoPtr = args[3] >>> 0;
        const buf = args[4] >>> 0;
        const buflen = (args[5] ?? 0) | 0;
        const task = makeAsyncTaskHandle();
        const hostPort = ((netPort & 0xff) << 8) | ((netPort >>> 8) & 0xff);
        const proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        const entry = KNOWN_SERVICES.find((s) => s.port === hostPort && (!proto || s.proto === proto));
        let bytes = 0;
        let error = 0;
        if (!entry) {
            error = WSANO_DATA;
        } else {
            bytes = packServentInto(mem, buf, buflen, entry);
            if (bytes < 0) { bytes = 0; error = WSAENOBUFS; }
        }
        postAsyncLookupCompletion(hWnd, wMsg, task, bytes, error);
        setLastError(0);
        return task;
    };

    return {
        WSAAsyncGetHostByName,
        WSAAsyncGetHostByAddr,
        WSAAsyncGetProtoByName,
        WSAAsyncGetProtoByNumber,
        WSAAsyncGetServByName,
        WSAAsyncGetServByPort,
    };
}

export const INVALID_SOCKET = -1;
export const SOCKET_ERROR = -1;

export const WSAENETDOWN = 10050;
export const WSAHOST_NOT_FOUND = 11001;
/** Valid name, no data record of requested type (service/proto lookup miss). */
export const WSANO_DATA = 11004;
export const WSAENOTSOCK = 10038;
export const WSAENOTCONN = 10057;
export const WSAEWOULDBLOCK = 10035;
export const WSAEFAULT = 10014;
export const WSAENOBUFS = 10055;

interface StubSocket {
    connected: boolean;
    nonBlocking: boolean;
}

/** Deterministic offline socket table — connect succeeds, I/O is no-network safe. */
export class WsaSocketTable {
    private nextId = 1;
    private sockets = new Map<number, StubSocket>();

    reset(): void {
        this.nextId = 1;
        this.sockets.clear();
    }

    socket(): number {
        const id = this.nextId++;
        this.sockets.set(id, { connected: false, nonBlocking: true });
        return id;
    }

    closesocket(s: number): number {
        if (!this.sockets.delete(s >>> 0)) return SOCKET_ERROR;
        return 0;
    }

    connect(s: number): number {
        const sock = this.sockets.get(s >>> 0);
        if (!sock) return SOCKET_ERROR;
        sock.connected = true;
        return 0;
    }

    bind(_s: number): number {
        return 0;
    }

    listen(_s: number): number {
        return 0;
    }

    accept(_s: number): number {
        return this.socket();
    }

    send(s: number, len: number): number {
        const sock = this.sockets.get(s >>> 0);
        if (!sock) return SOCKET_ERROR;
        if (!sock.connected) return SOCKET_ERROR;
        return Math.max(0, len | 0);
    }

    recv(s: number): number {
        const sock = this.sockets.get(s >>> 0);
        if (!sock) return SOCKET_ERROR;
        if (!sock.connected) return SOCKET_ERROR;
        return SOCKET_ERROR;
    }

    recvfrom(s: number): number {
        return this.recv(s);
    }

    sendto(s: number, len: number): number {
        const sock = this.sockets.get(s >>> 0);
        if (!sock) return SOCKET_ERROR;
        return Math.max(0, len | 0);
    }

    setsockopt(_s: number): number {
        return 0;
    }

    getsockopt(_s: number): number {
        return 0;
    }

    shutdown(_s: number): number {
        return 0;
    }

    isValid(s: number): boolean {
        return this.sockets.has(s >>> 0);
    }

    isConnected(s: number): boolean {
        return this.sockets.get(s >>> 0)?.connected ?? false;
    }

    ioctl(s: number, cmd: number, argp: number, mem: Uint8Array | null): number {
        const sock = this.sockets.get(s >>> 0);
        if (!sock) return SOCKET_ERROR;
        const FIONBIO = 0x8004667e;
        if (cmd === FIONBIO && argp) {
            const view = mem
                ? new DataView(mem.buffer, mem.byteOffset, mem.byteLength)
                : null;
            const on = view ? view.getUint32(argp, true) : (Mem.readUint32(argp) ?? 0);
            sock.nonBlocking = on !== 0;
        } else if (argp) {
            if (mem) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(argp, 0, true);
            } else {
                Mem.writeUint32(argp, 0);
            }
        }
        return 0;
    }
}

export function makeSocketExports(
    table: WsaSocketTable,
    setLastError: (code: number) => void,
): Record<string, ThunkImplementation> {
    const requireSocket = (s: number): boolean => {
        if (!table.isValid(s)) {
            setLastError(WSAENOTSOCK);
            return false;
        }
        return true;
    };

    return {
        socket: () => {
            const id = table.socket();
            setLastError(0);
            return id;
        },
        closesocket: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            const ret = table.closesocket(s);
            setLastError(ret === 0 ? 0 : WSAENOTSOCK);
            return ret;
        },
        connect: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.connect(s);
            setLastError(ret === SOCKET_ERROR ? WSAENOTCONN : 0);
            return ret;
        },
        bind: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            setLastError(0);
            return table.bind(s);
        },
        listen: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            setLastError(0);
            return table.listen(s);
        },
        accept: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return INVALID_SOCKET;
            setLastError(0);
            return table.accept(s);
        },
        send: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            const len = args[2] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.send(s, len);
            setLastError(ret === SOCKET_ERROR ? WSAENOTCONN : 0);
            return ret;
        },
        recv: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.recv(s);
            setLastError(ret === SOCKET_ERROR ? WSAEWOULDBLOCK : 0);
            return ret;
        },
        recvfrom: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.recvfrom(s);
            setLastError(ret === SOCKET_ERROR ? WSAEWOULDBLOCK : 0);
            return ret;
        },
        sendto: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            const len = args[2] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.sendto(s, len);
            setLastError(ret === SOCKET_ERROR ? WSAENOTCONN : 0);
            return ret;
        },
        setsockopt: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            setLastError(0);
            return table.setsockopt(s);
        },
        getsockopt: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            setLastError(0);
            return table.getsockopt(s);
        },
        shutdown: (_ctx, _mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            setLastError(0);
            return table.shutdown(s);
        },
        ioctlsocket: (_ctx, mem, args) => {
            const s = args[0] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            const ret = table.ioctl(s, args[1] >>> 0, args[2] >>> 0, mem);
            setLastError(ret === SOCKET_ERROR ? WSAENOTSOCK : 0);
            return ret;
        },
        getpeername: (_ctx, mem, args) => {
            const s = args[0] >>> 0;
            const name = args[1] >>> 0;
            const namelenPtr = args[2] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            if (!table.isConnected(s)) {
                setLastError(WSAENOTCONN);
                return SOCKET_ERROR;
            }
            if (!name || !namelenPtr) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const avail = mem
                ? new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getInt32(namelenPtr, true)
                : (Mem.readInt32(namelenPtr) ?? 0);
            if (avail < SOCKADDR_IN_SIZE) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (!writeSockaddrInLoopback(name, 0, mem)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (mem) {
                new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setInt32(namelenPtr, SOCKADDR_IN_SIZE, true);
            } else if (!Mem.writeUint32(namelenPtr, SOCKADDR_IN_SIZE)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },
        getsockname: (_ctx, mem, args) => {
            const s = args[0] >>> 0;
            const name = args[1] >>> 0;
            const namelenPtr = args[2] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;
            if (!name || !namelenPtr) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            const avail = mem
                ? new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getInt32(namelenPtr, true)
                : (Mem.readInt32(namelenPtr) ?? 0);
            if (avail < SOCKADDR_IN_SIZE) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (!writeSockaddrInLoopback(name, 0, mem)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            if (mem) {
                new DataView(mem.buffer, mem.byteOffset, mem.byteLength).setInt32(namelenPtr, SOCKADDR_IN_SIZE, true);
            } else if (!Mem.writeUint32(namelenPtr, SOCKADDR_IN_SIZE)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },
        WSAIoctl: (_ctx, mem, args) => {
            const s = args[0] >>> 0;
            const code = args[1] >>> 0;
            const inBuf = args[2] >>> 0;
            const outBuf = args[4] >>> 0;
            const outLen = args[5] >>> 0;
            const pBytesReturned = args[6] >>> 0;
            if (!requireSocket(s)) return SOCKET_ERROR;

            const FIONREAD = 0x4004667f;
            const FIONBIO = 0x8004667e;
            let bytesReturned = 0;

            if (code === FIONBIO && inBuf) {
                table.ioctl(s, FIONBIO, inBuf, mem);
            } else if (code === FIONREAD && outBuf && outLen >= 4) {
                if (!writeU32(mem, outBuf, 0)) {
                    setLastError(WSAEFAULT);
                    return SOCKET_ERROR;
                }
                bytesReturned = 4;
            } else if (outBuf && outLen > 0) {
                if (mem) {
                    if (outBuf < 0 || outBuf + outLen > mem.length) {
                        setLastError(WSAEFAULT);
                        return SOCKET_ERROR;
                    }
                    mem.fill(0, outBuf, outBuf + outLen);
                } else {
                    const zeros = new Uint8Array(outLen);
                    if (Mem.writeBytes(outBuf, zeros) !== outLen) {
                        setLastError(WSAEFAULT);
                        return SOCKET_ERROR;
                    }
                }
            }

            if (pBytesReturned && !writeU32(mem, pBytesReturned, bytesReturned)) {
                setLastError(WSAEFAULT);
                return SOCKET_ERROR;
            }
            setLastError(0);
            return 0;
        },
        WSASocketA: () => {
            const id = table.socket();
            setLastError(0);
            return id;
        },
    };
}

export function makeWsaStartup(
    setLastError: (code: number) => void,
    wsaeFault: number,
    socketError: number,
): ThunkImplementation {
    return (_ctx, mem, args) => {
        // stdcall: WSAStartup(WORD wVersionRequested, LPWSADATA lpWSAData)
        const wVersionRequested = args[0] ?? 0;
        const lpWSAData = args[1] >>> 0;
        if (!lpWSAData) {
            setLastError(wsaeFault);
            return socketError;
        }
        if (!writeWsaData(lpWSAData, wVersionRequested, mem)) {
            setLastError(wsaeFault);
            return socketError;
        }
        setLastError(0);
        return 0;
    };
}
