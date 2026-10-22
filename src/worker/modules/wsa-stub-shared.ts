/**
 * Shared Winsock ABI helpers and process-local provider state.
 */

import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { Marshaler } from "../core/memory/marshaler";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Process } from "../core/process";
import { System } from "../core/system";
import { lanNetwork } from "../net/lan-network";
import { parseIpv6, formatIpv6 } from "../net/netplay-wire";
import { WsaSocketTable } from "./wsa-network";
import { createWsaActorTable } from "./wsa-actor-table";
import { getSocketActorClient } from "../core/process-network";
import { makeNamespaceExports } from "./wsa-namespace";
import { getWsaOverlapped } from "./wsa-overlapped";
import { makeNetworkSocketExports, makeNetworkSelect, type WsaErrorSetter } from "./wsa-network-api";
export { WsaSocketTable } from "./wsa-network";

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
        if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) return INADDR_NONE;
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
const WSADATA_LPVENDORINFO_OFF = 396;

/** wVersion must not exceed the requested version; wHighVersion advertises our ceiling. */
export function negotiateWsaVersion(wVersionRequested: number): { wVersion: number; wHighVersion: number } {
    const major = wVersionRequested & 0xff;
    const minor = (wVersionRequested >>> 8) & 0xff;
    const wVersion = major >= 2
        ? ((major > 2 ? 2 : Math.min(minor, 2)) << 8) | 2
        : (Math.min(minor, 1) << 8) | 1;
    return { wVersion, wHighVersion: 0x0202 };
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
    desc.set(new TextEncoder().encode("BottleShip virtual LAN\0").subarray(0, 256));
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
 * Local/numeric resolver namespace shared by wsock32 and ws2_32.
 * A remote DNS resolver requires a gateway and unknown names fail explicitly.
 */
function localHostName(): string {
    return lanNetwork.connected ? `bottleship-${Array.from(lanNetwork.node.slice(3), b => b.toString(16).padStart(2, "0")).join("")}` : LOOPBACK_HOST_NAME;
}
function localHostAddress(): Uint8Array { return lanNetwork.connected ? lanNetwork.ipv4 : LOOPBACK_ADDR_BYTES; }
/** Only the local namespace and numeric IPv4 are available until a resolver gateway exists. */
function resolveLocalName(name: string): Uint8Array | null {
    if (!name || name.toLowerCase() === localHostName().toLowerCase()) return localHostAddress().slice();
    if (name.toLowerCase() === "localhost") return LOOPBACK_ADDR_BYTES.slice();
    const numeric = parseInetAddr(name);
    if (numeric === 0xffffffff && name !== "255.255.255.255") return null;
    return new Uint8Array([numeric & 255, numeric >>> 8 & 255, numeric >>> 16 & 255, numeric >>> 24 & 255]);
}

interface WsaResolvedName { canonicalName: string; addresses: Uint8Array[]; scopeIds?: number[]; }
function resolverError(error: unknown): number {
    const code = (error as { code?: string })?.code;
    return ({ HOST_NOT_FOUND: 11001, TRY_AGAIN: 11002, NO_RECOVERY: 11003, NO_DATA: 11004,
        CANCELLED: 10004, NETWORK_DOWN: 10050, ACCESS_DENIED: 10013 } as Record<string, number>)[code ?? ""] ?? 11003;
}
function resolveWsaName(name: string, signal?: AbortSignal, family: 0 | 4 | 6 = 4): WsaResolvedName | Promise<WsaResolvedName> {
    const local = resolveLocalName(name), ipv6 = parseIpv6(name);
    const localName = !name || name.toLowerCase() === localHostName().toLowerCase();
    const loopback = name.toLowerCase() === "localhost", loopback6 = new Uint8Array(16); loopback6[15] = 1;
    if (family !== 4 && ipv6) return { canonicalName: name, addresses: [ipv6] };
    if ((localName || loopback) && family !== 4) return { canonicalName: name || localHostName(),
        addresses: family === 6 ? [loopback ? loopback6 : lanNetwork.ipv6] :
            [loopback ? loopback6 : lanNetwork.ipv6, local!] };
    if (local && family !== 6) return { canonicalName: name || localHostName(), addresses: [local] };
    if (local || ipv6) return Promise.reject({ code: "NO_DATA" });
    return lanNetwork.resolve(name, family, signal).then(result => {
        const parsed = result.addresses.filter(a => !family || a.family === family).map(a => {
            if (a.family === 6) return { ip: parseIpv6(a.address), scopeId: a.scopeId ?? 0 };
            const ip = parseInetAddr(a.address);
            return { ip: new Uint8Array([ip & 255, ip >>> 8 & 255, ip >>> 16 & 255, ip >>> 24 & 255]), scopeId: 0 };
        }).filter((a): a is { ip: Uint8Array; scopeId: number } => !!a.ip);
        if (!parsed.length) throw { code: "NO_DATA" };
        return { canonicalName: result.canonicalName || name, addresses: parsed.map(a => a.ip), scopeIds: parsed.map(a => a.scopeId) };
    });
}
function dataWrites(address: number, data: Uint8Array): import("../core/thunking/thunk-dispatcher").DeferredWrite[] {
    const result: import("../core/thunking/thunk-dispatcher").DeferredWrite[] = [];
    let i = 0;
    for (; i + 4 <= data.length; i += 4) result.push({ address: address + i, size: 4,
        value: (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24) >>> 0 });
    for (; i < data.length; i++) result.push({ address: address + i, size: 1, value: data[i] });
    return result;
}
function hostentImage(base: number, result: WsaResolvedName): Uint8Array {
    const name = new TextEncoder().encode(result.canonicalName + "\0");
    const aliases = 16 + name.length, list = (aliases + 7) & ~3, addresses = list + 4 * (result.addresses.length + 1);
    const image = new Uint8Array(addresses + 4 * result.addresses.length), view = new DataView(image.buffer);
    view.setUint32(0, base + 16, true); view.setUint32(4, base + aliases, true);
    view.setUint16(8, 2, true); view.setUint16(10, 4, true); view.setUint32(12, base + list, true);
    image.set(name, 16);
    result.addresses.forEach((ip, i) => { view.setUint32(list + 4 * i, base + addresses + 4 * i, true); image.set(ip, addresses + 4 * i); });
    return image;
}
export function createDnsStubs(process: Process, setLastError: WsaErrorSetter): DnsStubs {
    const scratch = new Map<number, { generation: number; ptr: number }>();
    const table = getWsaProcessState(process).table;
    const buffer = (): number => {
        const tid = System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
        const old = scratch.get(tid);
        if (old?.generation === table.generation) return old.ptr;
        const ptr = process.memory.alloc(4096, "THUNK_DATA", "rw") >>> 0;
        if (ptr) scratch.set(tid, { generation: table.generation, ptr });
        return ptr;
    };
    const pack = (base: number, result: WsaResolvedName) => {
        const image = hostentImage(base, result);
        if (image.length > 4080) return null;
        return dataWrites(base, image);
    };
    const hostent = (result: WsaResolvedName): number => {
        const base = buffer(), writes = base ? pack(base, result) : null;
        if (!writes) { setLastError(WSAENOBUFS); return 0; }
        for (const write of writes) if (!(write.size === 4 ? Mem.writeUint32(write.address, write.value) : Mem.writeUint8(write.address, write.value))) {
            setLastError(WSAEFAULT); return 0;
        }
        return base;
    };
    const gethostname: ThunkImplementation = (_ctx, _mem, args) => {
        const ptr = args[0] >>> 0, length = args[1] | 0;
        const data = new TextEncoder().encode(localHostName() + "\0");
        if (!ptr || length < data.length || Mem.writeBytes(ptr, data) !== data.length) {
            setLastError(WSAEFAULT); return SOCKET_ERROR;
        }
        return 0;
    };
    const gethostbyname: ThunkImplementation = (_ctx, mem, args) => {
        const name = args[0] ? Marshaler.readString(mem, args[0] >>> 0).trim() : "";
        const report = setLastError.capture?.() ?? setLastError, generation = table.generation;
        const result = resolveWsaName(name, table.blockingSignal);
        if (!(result instanceof Promise)) return hostent(result);
        const base = buffer();
        if (!base) { report(WSAENOBUFS); return 0; }
        return result.then<import("../core/thunking/thunk-dispatcher").ThunkResult, import("../core/thunking/thunk-dispatcher").ThunkResult>(answer => {
            if (generation !== table.generation) return { value: 0 };
            const writes = pack(base, answer);
            if (!writes) { report(WSAENOBUFS); return { value: 0 }; }
            report(0); return { value: base, deferredWrites: writes };
        }, error => { if (generation === table.generation) report(resolverError(error)); return { value: 0 }; });
    };
    const gethostbyaddr: ThunkImplementation = (_ctx, _mem, args) => {
        if (!args[0] || (args[1] | 0) < 4 || args[2] !== AF_INET) { setLastError(WSAEFAULT); return 0; }
        const ip = Mem.readBytes(args[0] >>> 0, 4)?.slice();
        if (!ip) { setLastError(WSAEFAULT); return 0; }
        const local = localHostAddress();
        if (ip.every((v, i) => v === local[i])) return hostent({ canonicalName: localHostName(), addresses: [ip] });
        if (ip.every((v, i) => v === LOOPBACK_ADDR_BYTES[i])) return hostent({ canonicalName: LOOPBACK_HOST_NAME, addresses: [ip] });
        setLastError(WSAHOST_NOT_FOUND); return 0;
    };
    const inetNtoa: ThunkImplementation = (_ctx, _mem, args) => {
        const value = args[0] >>> 0, ptr = buffer();
        if (!ptr) { setLastError(WSAENOBUFS); return 0; }
        const data = new TextEncoder().encode(`${value & 255}.${value >>> 8 & 255}.${value >>> 16 & 255}.${value >>> 24 & 255}\0`);
        if (Mem.writeBytes(ptr + 4080, data) !== data.length) { setLastError(WSAEFAULT); return 0; }
        return ptr + 4080;
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
 * local hostnames resolve to the virtual interface and unknown names fail.
 *
 * The result chain is allocated in guest memory and owned by us until freeaddrinfo — the
 * caller must not free it itself, so a per-call allocation set is tracked and released as a
 * unit. A dangling free (an addrinfo we never handed out) is ignored, matching the DLL's own
 * tolerance rather than corrupting the heap.
 */
export function createAddrInfoStubs(process: Process, setLastError: WsaErrorSetter): AddrInfoStubs {
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
        const nodePtr = args[0] >>> 0, servicePtr = args[1] >>> 0, hintsPtr = args[2] >>> 0, resultPtr = args[3] >>> 0;
        const report = setLastError.capture?.() ?? setLastError;
        const error = (code: number) => { report(code); return code; };
        if (!resultPtr || !isValidAddress(mem, resultPtr, 4, "rw")) return error(WSAEFAULT);
        let flags = 0, family = AF_UNSPEC, socktype = 0, protocol = 0;
        if (hintsPtr) {
            if (!isValidAddress(mem, hintsPtr, ADDRINFO_SIZE, "r")) return error(WSAEFAULT);
            flags = Mem.readUint32(hintsPtr) ?? 0; family = Mem.readUint32(hintsPtr + 4) ?? 0;
            socktype = Mem.readUint32(hintsPtr + 8) ?? 0; protocol = Mem.readUint32(hintsPtr + 12) ?? 0;
        }
        if (family !== AF_UNSPEC && family !== AF_INET && family !== 23) return error(EAI_FAMILY);
        if (flags & ~0xd0f) return error(WSAEINVAL);
        if (socktype && socktype !== SOCK_STREAM && socktype !== SOCK_DGRAM && socktype !== SOCK_RAW) return error(WSAESOCKTNOSUPPORT);
        if (protocol > 255 || (protocol && socktype !== SOCK_RAW && socktype && protocol !== IPPROTO_TCP && protocol !== IPPROTO_UDP)) return error(WSAEPROTONOSUPPORT);
        if ((socktype === SOCK_STREAM && protocol === IPPROTO_UDP) || (socktype === SOCK_DGRAM && protocol === IPPROTO_TCP)) return error(EAI_SERVICE);
        const node = nodePtr ? Marshaler.readString(mem, nodePtr).trim() : "";
        const service = servicePtr ? Marshaler.readString(mem, servicePtr).trim() : "";
        if (!nodePtr && !servicePtr) return error(EAI_NONAME);
        if ((socktype === SOCK_RAW && service) || ((flags & 8) && service && !/^[0-9]+$/.test(service))) return error(EAI_SERVICE);
        const port = parsePort(service, { socktype });
        if (port === null) return error(EAI_SERVICE);
        if ((flags & AI_NUMERICHOST) && node && !parseIpv6(node) && parseInetAddr(node) === 0xffffffff && node !== "255.255.255.255") return error(EAI_NONAME);
        const kinds = socktype ? [{ socktype, protocol: socktype === SOCK_RAW ? protocol : protocol || (socktype === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP) }]
            : protocol ? [{ socktype: protocol === IPPROTO_UDP ? SOCK_DGRAM : protocol === IPPROTO_TCP ? SOCK_STREAM : SOCK_RAW, protocol }]
            : [{ socktype: SOCK_STREAM, protocol: IPPROTO_TCP }, { socktype: SOCK_DGRAM, protocol: IPPROTO_UDP }];
        const table = getWsaProcessState(process).table, generation = table.generation;
        const build = (answer: WsaResolvedName, deferred: boolean): number | import("../core/thunking/thunk-dispatcher").ThunkResult => {
            if (generation !== table.generation) return { value: 10004 };
            const canonical = (flags & AI_CANONNAME) ? new TextEncoder().encode(answer.canonicalName + "\0") : new Uint8Array(0);
            const entries = answer.addresses.flatMap((ip, index) => kinds.map(kind => ({ ip, kind, scopeId: answer.scopeIds?.[index] ?? 0, size: ip.length === 16 ? 28 : SOCKADDR_IN_SIZE })));
            const count = entries.length, records = entries.reduce((size, entry) => size + ADDRINFO_SIZE + entry.size, 0);
            const size = records + canonical.length;
            let base = 0;
            try { base = process.memory.alloc(size, "THUNK_DATA", "rw") >>> 0; } catch { return deferred ? { value: error(EAI_MEMORY) } : error(EAI_MEMORY); }
            if (!base) return deferred ? { value: error(EAI_MEMORY) } : error(EAI_MEMORY);
            const image = new Uint8Array(size), view = new DataView(image.buffer);
            let offset = 0, index = 0;
            for (const entry of entries) {
                const { ip, kind, size } = entry, sa = offset + ADDRINFO_SIZE, af = ip.length === 16 ? 23 : AF_INET;
                view.setUint32(offset, flags, true); view.setUint32(offset + 4, af, true);
                view.setUint32(offset + 8, kind.socktype, true); view.setUint32(offset + 12, kind.protocol, true);
                view.setUint32(offset + 16, size, true); view.setUint32(offset + 20, !index && canonical.length ? base + records : 0, true);
                view.setUint32(offset + 24, base + sa, true); view.setUint32(offset + 28, index + 1 < count ? base + sa + size : 0, true);
                view.setUint16(sa, af, true); view.setUint16(sa + 2, port, false); image.set(ip, sa + (af === 23 ? 8 : 4));
                if (af === 23) view.setUint32(sa + 24, node.includes("%") ? Number(node.split("%")[1]) >>> 0 : entry.scopeId, true);
                offset += ADDRINFO_SIZE + size; index++;
            }
            image.set(canonical, records);
            const writes = [...dataWrites(base, image), { address: resultPtr, size: 4 as const, value: base }];
            chains.set(base, [base]); report(0);
            if (deferred) return { value: 0, deferredWrites: writes };
            for (const write of writes) if (!(write.size === 4 ? Mem.writeUint32(write.address, write.value) : Mem.writeUint8(write.address, write.value))) {
                chains.delete(base); process.memory.free(base); return error(WSAEFAULT);
            }
            return 0;
        };
        const loopback6 = new Uint8Array(16); loopback6[15] = 1;
        let lookup: WsaResolvedName | Promise<WsaResolvedName>;
        try {
            if (node && family === 23 && (flags & 0x800) && resolveLocalName(node)) {
                const ip = resolveLocalName(node)!, mapped = new Uint8Array(16); mapped[10] = mapped[11] = 255; mapped.set(ip, 12);
                lookup = { canonicalName: node, addresses: [mapped] };
            } else lookup = node ? resolveWsaName(node, table.blockingSignal, family === 23 ? 6 : family === 2 ? 4 : 0) :
                { canonicalName: LOOPBACK_HOST_NAME, addresses: family === 23 ? [flags & AI_PASSIVE ? new Uint8Array(16) : loopback6] :
                    family === 2 ? [flags & AI_PASSIVE ? new Uint8Array(4) : LOOPBACK_ADDR_BYTES.slice()] :
                    [flags & AI_PASSIVE ? new Uint8Array(16) : loopback6, flags & AI_PASSIVE ? new Uint8Array(4) : LOOPBACK_ADDR_BYTES.slice()] };
        } catch (reason) { return error(resolverError(reason)); }
        if (!(lookup instanceof Promise)) return build(lookup, false) as number;
        return lookup.then<import("../core/thunking/thunk-dispatcher").ThunkResult, import("../core/thunking/thunk-dispatcher").ThunkResult>(
            answer => build(answer, true) as import("../core/thunking/thunk-dispatcher").ThunkResult,
            reason => ({ value: generation === table.generation ? error(resolverError(reason)) : 10004 }));
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
        const family = Mem.readUint16(saPtr) ?? 0;
        if (family !== AF_INET && family !== 23) { setLastError(EAI_FAMILY); return EAI_FAMILY; }
        if (family === 23 && saLen < 28) { setLastError(WSAEFAULT); return WSAEFAULT; }

        const netPort = (Mem.readUint16(saPtr + 2) ?? 0) >>> 0;
        const port = ((netPort & 0xff) << 8) | ((netPort >>> 8) & 0xff);
        const ip = Mem.readBytes(saPtr + (family === 23 ? 8 : 4), family === 23 ? 16 : 4)?.slice();
        if (!ip) { setLastError(WSAEFAULT); return WSAEFAULT; }
        const scopeId = family === 23 ? Mem.readUint32(saPtr + 24) ?? 0 : 0;
        const dotted = family === 23 ? formatIpv6(ip) + (scopeId ? "%" + scopeId : "") : Array.from(ip).join(".");

        const write = (text: string, ptr: number, len: number): boolean => {
            if (!ptr || len === 0) return true;
            const bytes = new TextEncoder().encode(`${text}\0`);
            if (bytes.length > len) return false;
            return Mem.writeBytes(ptr, bytes) === bytes.length;
        };

        if (hostPtr && hostLen) {
            // Only loopback has a name offline; NI_NAMEREQD must fail rather than hand back a literal.
            const loopback = family === 23 ? ip.slice(0, 15).every(v => !v) && ip[15] === 1 : ip.every((v, i) => v === LOOPBACK_ADDR_BYTES[i]);
            const local = family === 23 ? lanNetwork.ipv6 : localHostAddress();
            const localName = loopback ? LOOPBACK_HOST_NAME : ip.every((v, i) => v === local[i]) ? localHostName() : "";
            const named = !(flags & NI_NUMERICHOST) && localName;
            if (!named && (flags & NI_NAMEREQD)) { setLastError(EAI_NONAME); return EAI_NONAME; }
            if (!write(named ? localName : dotted, hostPtr, hostLen)) {
                setLastError(WSAEFAULT);
                return WSAEFAULT;
            }
        }
        if (servPtr && servLen) {
            const entry = (flags & NI_NUMERICSERV) ? undefined : KNOWN_SERVICES.find((s) => s.port === port && s.proto === (flags & 0x10 ? "udp" : "tcp"));
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
export function makeSelect(table: WsaSocketTable, setLastError: WsaErrorSetter, counter?: WsaStartupCount): ThunkImplementation {
    return makeNetworkSelect(table, setLastError, counter);
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
    WSACancelAsyncRequest: ThunkImplementation;
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
const asyncLookupStates = new WeakMap<Process, AsyncLookupStubs>();
export function createAsyncLookupStubs(setLastError: WsaErrorSetter, owner?: Process): AsyncLookupStubs {
    const process = owner ?? System.getInstance().process;
    if (process) {
        const old = asyncLookupStates.get(process);
        if (old) return old;
    }
    const table = process ? getWsaProcessState(process).table : null;
    const tasks = new Map<number, { controller: AbortController; generation: number }>();
    const enqueue = (hWnd: number, wMsg: number, buf: number, buflen: number,
        query: (signal: AbortSignal) => Uint8Array | Promise<Uint8Array>): number => {
        if (!process || !table) { setLastError(WSAENETDOWN); return 0; }
        const state = getWsaProcessState(process);
        if (!state.counter.started) { setLastError(WSANOTINITIALISED); return 0; }
        const task = makeAsyncTaskHandle(), controller = new AbortController(), generation = table.generation;
        tasks.set(task, { controller, generation });
        const complete = (image?: Uint8Array, error = 0) => {
            const request = tasks.get(task);
            if (!request || request.generation !== table.generation) { tasks.delete(task); return; }
            // Once publication is queued this request has completed; cancellation now returns WSAEINVAL.
            tasks.delete(task);
            const required = image?.length ?? 0;
            if (image && required > buflen) { image = undefined; error = WSAENOBUFS; }
            if (image && (!buf || !process.addressSpace.validateRange(buf, image.length, "w"))) { image = undefined; error = WSAEFAULT; }
            process.enqueueCompletion(image ? dataWrites(buf, image) : [], published => {
                if (generation !== table.generation) return;
                postAsyncLookupCompletion(hWnd, wMsg, task, required, published ? error : WSAEFAULT);
            });
        };
        queueMicrotask(() => {
            if (!tasks.has(task) || generation !== table.generation) { tasks.delete(task); return; }
            try {
                const result = query(controller.signal);
                if (result instanceof Promise) result.then(image => complete(image), reason => complete(undefined, resolverError(reason)));
                else complete(result);
            } catch (reason) { complete(undefined, resolverError(reason)); }
        });
        setLastError(0); return task;
    };
    if (table) {
        let generation = table.generation;
        table.subscribe(() => {
            if (generation === table.generation) return;
            generation = table.generation;
            for (const request of tasks.values()) request.controller.abort();
            tasks.clear();
        });
    }
    const protoImage = (base: number, entry: ProtoEntry): Uint8Array => {
        const name = new TextEncoder().encode(entry.name + "\0"), aliases = 12 + name.length;
        const image = new Uint8Array(aliases + 4), view = new DataView(image.buffer);
        view.setUint32(0, base + 12, true); view.setUint32(4, base + aliases, true); view.setUint16(8, entry.number, true);
        image.set(name, 12); return image;
    };
    const servImage = (base: number, entry: ServEntry): Uint8Array => {
        const name = new TextEncoder().encode(entry.name + "\0"), proto = new TextEncoder().encode(entry.proto + "\0");
        const aliases = 16 + name.length + proto.length, image = new Uint8Array(aliases + 4), view = new DataView(image.buffer);
        view.setUint32(0, base + 16, true); view.setUint32(4, base + aliases, true); view.setUint16(8, entry.port, false);
        view.setUint32(12, base + 16 + name.length, true); image.set(name, 16); image.set(proto, 16 + name.length); return image;
    };
    const missing = (): never => { throw { code: "NO_DATA" }; };
    const WSAAsyncGetHostByName: ThunkImplementation = (_ctx, mem, args) => {
        const [hWnd, wMsg, namePtr, buf, buflen] = args.slice(), name = namePtr ? Marshaler.readString(mem, namePtr).trim() : "";
        return enqueue(hWnd, wMsg, buf, buflen, signal => {
            const result = resolveWsaName(name, signal);
            return result instanceof Promise ? result.then(answer => hostentImage(buf, answer)) : hostentImage(buf, result);
        });
    };
    const WSAAsyncGetHostByAddr: ThunkImplementation = (_ctx, _mem, args) => {
        const [hWnd, wMsg, addrPtr, len, type, buf, buflen] = args.slice(), ip = addrPtr && len >= 4 && type === AF_INET ? Mem.readBytes(addrPtr, 4)?.slice() : undefined;
        return enqueue(hWnd, wMsg, buf, buflen, () => {
            const local = localHostAddress();
            if (!ip || (!ip.every((v, i) => v === local[i]) && !ip.every((v, i) => v === LOOPBACK_ADDR_BYTES[i]))) throw { code: "HOST_NOT_FOUND" };
            return hostentImage(buf, { canonicalName: ip[0] === 127 ? LOOPBACK_HOST_NAME : localHostName(), addresses: [ip] });
        });
    };
    const WSAAsyncGetProtoByName: ThunkImplementation = (_ctx, mem, args) => {
        const [hWnd, wMsg, namePtr, buf, buflen] = args.slice(), name = namePtr ? Marshaler.readString(mem, namePtr).trim().toLowerCase() : "";
        return enqueue(hWnd, wMsg, buf, buflen, () => protoImage(buf, KNOWN_PROTOCOLS.find(p => p.name === name) ?? missing()));
    };
    const WSAAsyncGetProtoByNumber: ThunkImplementation = (_ctx, _mem, args) => {
        const [hWnd, wMsg, number, buf, buflen] = args.slice();
        return enqueue(hWnd, wMsg, buf, buflen, () => protoImage(buf, KNOWN_PROTOCOLS.find(p => p.number === number) ?? missing()));
    };
    const WSAAsyncGetServByName: ThunkImplementation = (_ctx, mem, args) => {
        const [hWnd, wMsg, namePtr, protoPtr, buf, buflen] = args.slice();
        const name = namePtr ? Marshaler.readString(mem, namePtr).trim().toLowerCase() : "", proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        return enqueue(hWnd, wMsg, buf, buflen, () => servImage(buf, KNOWN_SERVICES.find(s => s.name === name && (!proto || proto === s.proto)) ?? missing()));
    };
    const WSAAsyncGetServByPort: ThunkImplementation = (_ctx, mem, args) => {
        const [hWnd, wMsg, netPort, protoPtr, buf, buflen] = args.slice(), port = ((netPort & 255) << 8) | ((netPort >>> 8) & 255);
        const proto = protoPtr ? Marshaler.readString(mem, protoPtr).trim().toLowerCase() : "";
        return enqueue(hWnd, wMsg, buf, buflen, () => servImage(buf, KNOWN_SERVICES.find(s => s.port === port && (!proto || proto === s.proto)) ?? missing()));
    };
    const WSACancelAsyncRequest: ThunkImplementation = (_ctx, _mem, args) => {
        const request = tasks.get(args[0]);
        if (!request || request.generation !== table?.generation) { setLastError(WSAEINVAL); return SOCKET_ERROR; }
        tasks.delete(args[0]); request.controller.abort(); setLastError(0); return 0;
    };
    const result = { WSAAsyncGetHostByName, WSAAsyncGetHostByAddr, WSAAsyncGetProtoByName,
        WSAAsyncGetProtoByNumber, WSAAsyncGetServByName, WSAAsyncGetServByPort, WSACancelAsyncRequest };
    if (process) asyncLookupStates.set(process, result);
    return result;
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
export const WSAEINVAL = 10022;
export const WSAEPROTONOSUPPORT = 10043;
export const WSAESOCKTNOSUPPORT = 10044;
export const WSAEAFNOSUPPORT = 10047;
export const WSAVERNOTSUPPORTED = 10092;
export const WSANOTINITIALISED = 10093;

/**
 * The process's WSAStartup count. wsock32 forwards to ws2_32 on Windows, so a startup made
 * through either DLL is one count, and the last WSACleanup through either ends it.
 */
export class WsaStartupCount {
    private count = 0;
    private negotiatedVersion = 0x0202;
    constructor(private readonly onFinalCleanup?: () => void) {}
    get version(): number { return this.negotiatedVersion; }

    get started(): boolean {
        return this.count > 0;
    }

    startup(version = 0x0202): void {
        const current = this.negotiatedVersion;
        if (!this.count || (version & 255) < (current & 255) || ((version & 255) === (current & 255) && (version >>> 8) < (current >>> 8))) this.negotiatedVersion = version;
        this.count++;
    }

    /** WSACleanup: false (WSANOTINITIALISED) when there is no startup left to undo. */
    cleanup(): boolean {
        if (this.count === 0) return false;
        this.count--;
        if (this.count === 0) { this.negotiatedVersion = 0x0202; this.onFinalCleanup?.(); }
        return true;
    }

    reset(): void {
        this.count = 0; this.negotiatedVersion = 0x0202;
    }
}

export const wsaStartupCount = new WsaStartupCount();

/** WSACleanup against a startup count, with Winsock's error reporting. */
export function makeWsaCleanup(
    counter: WsaStartupCount,
    setLastError: (code: number) => void,
): ThunkImplementation {
    return () => {
        if (!counter.cleanup()) {
            setLastError(WSANOTINITIALISED);
            return SOCKET_ERROR;
        }
        setLastError(0);
        return 0;
    };
}

const AF_IPX = 6;
const AF_INET6 = 23;
const AF_BTH = 32;
const SOCK_RAW = 3;
const SOCK_SEQPACKET = 5;

/** The provider catalog (Wine ws2_32 supported_protocols): family, type, protocol range. */
const PROTOCOL_CATALOG: ReadonlyArray<{ af: number; type: number; protocol: number; maxOffset: number }> = [
    { af: AF_INET, type: SOCK_STREAM, protocol: IPPROTO_TCP, maxOffset: 0 },
    { af: AF_INET, type: SOCK_DGRAM, protocol: IPPROTO_UDP, maxOffset: 0 },
    { af: AF_INET, type: SOCK_RAW, protocol: 0, maxOffset: 255 },
    { af: AF_INET6, type: SOCK_STREAM, protocol: IPPROTO_TCP, maxOffset: 0 },
    { af: AF_INET6, type: SOCK_DGRAM, protocol: IPPROTO_UDP, maxOffset: 0 },
    { af: AF_INET6, type: SOCK_RAW, protocol: 0, maxOffset: 255 },
    { af: AF_IPX, type: SOCK_DGRAM, protocol: 1000, maxOffset: 255 },
    { af: AF_IPX, type: SOCK_SEQPACKET, protocol: 1256, maxOffset: 0 },
    { af: AF_IPX, type: SOCK_SEQPACKET, protocol: 1257, maxOffset: 0 },
    { af: AF_BTH, type: SOCK_STREAM, protocol: 3, maxOffset: 0 },
];

/**
 * socket()/WSASocket() argument check against the catalog: 0 when some provider serves
 * (af, type, protocol) — a zero type or protocol matches any — else the WSA error naming
 * the first coordinate no provider accepts.
 */
export function validateSocketTriple(af: number, type: number, protocol: number): number {
    if (af === AF_UNSPEC && protocol === 0) return WSAEINVAL;
    const byFamily = PROTOCOL_CATALOG.filter((e) => af === AF_UNSPEC || e.af === af);
    if (byFamily.length === 0) return WSAEAFNOSUPPORT;
    const byType = byFamily.filter((e) => type === 0 || e.type === type);
    if (byType.length === 0) return WSAESOCKTNOSUPPORT;
    const served = byType.some((e) => protocol === 0 ||
        (protocol >= e.protocol && protocol <= e.protocol + e.maxOffset));
    return served ? 0 : WSAEPROTONOSUPPORT;
}

/** Socket exports use the virtual LAN; unavailable providers fail explicitly. */
export function makeSocketExports(
    table: WsaSocketTable,
    setLastError: WsaErrorSetter,
    counter: WsaStartupCount = wsaStartupCount,
    process?: Process,
): Record<string, ThunkImplementation> {
    const sockets = makeNetworkSocketExports(table, setLastError, counter, validateSocketTriple, process);
    if (process) Object.assign(sockets, makeNamespaceExports(process, table, counter, setLastError, resolveWsaName, resolverError));
    return sockets;
}

export interface WsaProcessState {
    table: WsaSocketTable;
    counter: WsaStartupCount;
    setError: WsaErrorSetter;
    getError(): number;
    reset(): void;
}
const processStates = new WeakMap<Process, WsaProcessState>();
/** Kernel calls can use an authenticated OS descriptor before loading a Winsock DLL. */
export function getWsaNativeSocketTable(process: Process, socket: number): WsaSocketTable | undefined {
    // All emulated socket aliases occupy this range; unrelated kernel/file handles
    // must not initialize a provider or allocate a socket actor client.
    if (!Number.isInteger(socket) || socket < 0x10000000 || socket > 0x7fffffff) return undefined;
    const table = (processStates.get(process) ?? getWsaProcessState(process)).table;
    // isValid is an actor lookup under this process's PID/epoch, never a Winsock
    // context import. Keep the base identity for shared overlapped queues.
    return table.nativeHandleView.isValid(socket) ? table : undefined;
}
export function hasWsaSocket(process: Process, socket: number): boolean {
    return getWsaNativeSocketTable(process, socket) !== undefined;
}
export function cancelWsaIo(process: Process, socket: number, overlapped = 0, thread?: number): number | null {
    const table = getWsaNativeSocketTable(process, socket);
    return table ? getWsaOverlapped(table, process).cancel(socket, overlapped, thread) : null;
}
/** Both DLLs are views of the same per-process provider and per-thread last-error state. */
/** Read-only lookup for Win32 socket-handle bridges; never initializes Winsock. */
export function getWsaSocketTable(process: Process): WsaSocketTable | undefined { return processStates.get(process)?.table; }
export function getWsaProcessState(process: Process): WsaProcessState {
    const old = processStates.get(process);
    if (old) return old;
    const inBrowserWorker = typeof (globalThis as { importScripts?: unknown }).importScripts === "function";
    const table = inBrowserWorker ? createWsaActorTable(lanNetwork, getSocketActorClient) : new WsaSocketTable();
    const counter = new WsaStartupCount(() => table.reset());
    let epoch = 0;
    const thread = () => System.getInstance().scheduler?.getCurrentThreadId?.() ?? 0;
    const setError: WsaErrorSetter = code => { System.getInstance().scheduler.setLastError(code); };
    setError.capture = () => {
        const tid = thread(), generation = epoch, owner = System.getInstance().scheduler, sink = table.blockingErrorSink;
        return code => { if (generation === epoch) { if (sink) sink(code); else owner.setLastErrorForThread(tid, code); } };
    };
    const state: WsaProcessState = { table, counter, setError, getError: () => System.getInstance().scheduler.getLastError(),
        reset: () => { epoch++; table.reset(); counter.reset(); } };
    processStates.set(process, state);
    return state;
}

/**
 * WSAStartup(WORD wVersionRequested, LPWSADATA lpWSAData). The error is the RETURN value —
 * there is no Winsock yet to hold a last error — and only a successful call is counted.
 */
export function makeWsaStartup(
    setLastError: (code: number) => void,
    wsaeFault: number,
    _socketError: number,
    counter: WsaStartupCount = wsaStartupCount,
): ThunkImplementation {
    return (_ctx, mem, args) => {
        const wVersionRequested = args[0] ?? 0;
        const lpWSAData = args[1] >>> 0;
        if (lpWSAData && !writeWsaData(lpWSAData, wVersionRequested, mem)) return wsaeFault;
        if ((wVersionRequested & 0xff) === 0) return WSAVERNOTSUPPORTED;
        if (!lpWSAData) return wsaeFault;
        counter.startup(negotiateWsaVersion(wVersionRequested).wVersion);
        setLastError(0);
        return 0;
    };
}
