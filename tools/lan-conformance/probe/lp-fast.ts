/**
 * lp-fast — fast path: interpret a single-process .lp case inside bun, calling
 * the HLE socket table directly, and diff against the same native golden the
 * PE-based lan-diff check uses. No browser, no bundle.
 *
 *   bun tools/lan-conformance/probe/lp-fast.ts run <area>/<case>     # print the log
 *   bun tools/lan-conformance/probe/lp-fast.ts check <area>/<case>   # diff vs golden
 *
 * Supported verbs are the single-process Winsock subset of lanprobe.c
 * (wsastartup … shutdown, select with a timeout). gate/publishaddr/multi-role
 * stay with the PE-based runner. The log format is the probe's canonical one,
 * line for line, so one golden serves both paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LanNetwork } from "../../../src/worker/net/lan-network";
import { WsaSocketTable, WSA, ipv4Address, type WsaAddress } from "../../../src/worker/modules/wsa-network";

const root = resolve(import.meta.dir, "../../..");
const casesRoot = join(root, "tools/lan-conformance/cases");

const errNames: Record<number, string> = {
    10004: "WSAEINTR", 10009: "WSAEBADF", 10013: "WSAEACCES", 10014: "WSAEFAULT", 10022: "WSAEINVAL",
    10024: "WSAEMFILE", 10035: "WSAEWOULDBLOCK", 10036: "WSAEINPROGRESS", 10037: "WSAEALREADY",
    10038: "WSAENOTSOCK", 10039: "WSAEDESTADDRREQ", 10040: "WSAEMSGSIZE", 10041: "WSAEPROTOTYPE",
    10042: "WSAENOPROTOOPT", 10043: "WSAEPROTONOSUPPORT", 10044: "WSAESOCKTNOSUPPORT",
    10045: "WSAEOPNOTSUPP", 10046: "WSAEPFNOSUPPORT", 10047: "WSAEAFNOSUPPORT", 10048: "WSAEADDRINUSE",
    10049: "WSAEADDRNOTAVAIL", 10050: "WSAENETDOWN", 10051: "WSAENETUNREACH", 10052: "WSAENETRESET",
    10053: "WSAECONNABORTED", 10054: "WSAECONNRESET", 10055: "WSAENOBUFS", 10056: "WSAEISCONN",
    10057: "WSAENOTCONN", 10058: "WSAESHUTDOWN", 10059: "WSAETOOMANYREFS", 10060: "WSAETIMEDOUT",
    10061: "WSAECONNREFUSED", 10062: "WSAELOOP", 10063: "WSAENAMETOOLONG", 10064: "WSAEHOSTDOWN",
    10065: "WSAEHOSTUNREACH", 10066: "WSAENOTEMPTY", 10067: "WSAEPROCLIM", 10093: "WSANOTINITIALISED",
};
const errName = (code: number) => errNames[code] ?? String(code);
const CONSTANT: Record<string, number> = {
    AF_INET: 2, AF_INET6: 23, AF_UNSPEC: 0,
    SOCK_STREAM: 1, SOCK_DGRAM: 2, SOCK_RAW: 3,
    IPPROTO_ICMP: 1, IPPROTO_TCP: 6, IPPROTO_UDP: 17,
    SOL_SOCKET: 0xffff, SO_TYPE: 0x1004, SO_SNDBUF: 0x1001, SO_RCVBUF: 0x1002,
    SO_REUSEADDR: 4, SO_KEEPALIVE: 9, SO_BROADCAST: 32, SO_DONTROUTE: 16,
    SO_ERROR: 0x1007, SO_RCVTIMEO: 0x1006, SO_SNDTIMEO: 0x1005, SO_LINGER: 0x80,
    SO_OOBINLINE: 0x100, FIONREAD: 0x4004667f, FIONBIO: 0x8004667e, SIOCATMARK: 0x40047307,
    SIO_UDP_CONNRESET: 0x9800000c, SIO_UDP_NETERR: 0x9800000f,
    MSG_PEEK: 2, MSG_OOB: 1, MSG_DONTROUTE: 4,
    SD_RECEIVE: 0, SD_SEND: 1, SD_BOTH: 2,
};
const hrName = (hr: number) => {
    if (hr === 0) return "0";
    if (hr === 1) return "S_FALSE";
    return errName(hr & 0xffff) === String(hr & 0xffff) ? `0x${(hr >>> 0).toString(16)}` : errName(hr & 0xffff);
};

interface Symbol { sid?: number; addr?: WsaAddress; open?: boolean }
const lines: string[] = [];
let network: LanNetwork, table: WsaSocketTable;
const syms = new Map<string, Symbol>();
const started = { count: 0 };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const out = (line: string) => lines.push(line);
const failCode = (error: unknown): number =>
    error && typeof error === "object" && "code" in error ? Number((error as { code: number }).code) | 0 : -1;
const str = (t: { start: string; len: number; isStr: boolean }) => t.start.slice(0, t.len);
const dataOf = (t: { start: string; len: number; isStr: boolean }): Uint8Array => {
    const text = str(t);
    if (t.isStr) return new TextEncoder().encode(text);
    if (text.startsWith("u8:")) return Uint8Array.of(Number(text.slice(3)) & 255);
    if (text.startsWith("u32:")) { const v = Number(text.slice(4)) >>> 0; return Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255); }
    if (text.startsWith("buf:")) return new Uint8Array(Number(text.slice(4)));
    throw new Error(`bad data literal ${text}`);
};
const intOf = (text: string): number | null => {
    if (/^-?\d+$/.test(text)) return Number(text);
    if (/^0x[0-9a-fA-F]+$/.test(text)) return Number(text);
    if (CONSTANT[text] !== undefined) return CONSTANT[text];
    return null;
};
const appendAddr = (addr: WsaAddress) => {
    const ip = addr.ip ? [...addr.ip].join(".") : "0.0.0.0";
    const port = addr.port;
    for (const [name, sym] of syms) if (sym.addr?.port === port && sym.addr.ip?.every((b, i) => b === addr.ip?.[i])) {
        return `${ip}:<${name}>.port`;
    }
    return `${ip}:${port}`;
};
const appendData = (data: Uint8Array) => {
    const printable = [...data].every(b => (b >= 0x20 && b <= 0x7e && b !== 0x22 && b !== 0x5c) || false) || data.length === 0;
    if (printable) {
        let body = "";
        for (const b of data) { const c = String.fromCharCode(b); if (c === '"' || c === "\\") body += "\\"; body += c; }
        return `"${body}"`;
    }
    return "hex:" + [...data].map(b => b.toString(16).padStart(2, "0")).join("");
};
const socketPortTag = (sid: number) => {
    const local = (table.get(sid) as { local?: WsaAddress }).local;
    return local?.ip ? local : undefined;
};

async function execute(line: string): Promise<void> {
    // tokenizer: words and "quoted" strings; a bare # starts a comment
    const toks: Array<{ start: string; len: number; isStr: boolean }> = [];
    {
        let i = 0;
        while (i < line.length) {
            while (i < line.length && /\s/.test(line[i])) i++;
            if (i >= line.length || line[i] === "#") break;
            if (line[i] === '"') {
                const start = ++i;
                while (i < line.length && line[i] !== '"') i++;
                toks.push({ start: line.slice(start, i), len: i - start, isStr: true });
                i++;
            } else {
                const start = i;
                while (i < line.length && !/\s/.test(line[i]) && line[i] !== "#") i++;
                toks.push({ start: line.slice(start, i), len: i - start, isStr: false });
            }
        }
    }
    if (!toks.length) return;
    let assigned: string | undefined;
    let arg = 0;
    if (toks.length >= 2 && !toks[1].isStr && str(toks[1]) === "=") { assigned = str(toks[0]); arg = 2; }
    const verb = str(toks[arg]);
    const rest = toks.slice(arg + 1);
    const sym = (idx: number): Symbol | undefined => syms.get(str(rest[idx]));
    const socketId = (idx: number): number | null => sym(idx)?.sid ?? null;
    const addrOf = (idx: number): WsaAddress | null => {
        const text = str(rest[idx]);
        if (!text.includes(":")) {
            const base = text.endsWith(".addr") ? syms.get(text.slice(0, -5)) : syms.get(text);
            return base?.addr ?? null;
        }
        const cut = text.lastIndexOf(":");
        const ip = text.slice(0, cut).split(".").map(Number);
        const portText = text.slice(cut + 1);
        let port: number | null = null;
        const portMatch = portText.match(/^<(.+)>\.port$/);
        if (portMatch) port = syms.get(portMatch[1])?.addr?.port ?? null;
        else port = intOf(portText);
        if (ip.length !== 4 || ip.some(n => !Number.isInteger(n) || n < 0 || n > 255) || port === null) return null;
        return ipv4Address(Uint8Array.from(ip), port);
    };
    const hrLine = (prefix: string, hr: number, suffix = "") => {
        // failure lines always print ret=-1 (SOCKET_ERROR) and the named error code
        out(`${prefix} -> ret=${hr === 0 ? "0" : "-1"} err=${hrName(hr === 0 ? 0 : Math.abs(hr) || hr)}${suffix}`);
    };

    switch (true) {
        case verb === "echo": out("#" + (rest.length ? " " + rest.map(str).join(" ") : "")); return;
        case verb === "sleep": {
            const ms = Number(str(rest[0]));
            await sleep(ms);
            out(`${verb} ${ms} -> ret=0 err=0`);
            return;
        }
        case verb === "wsastartup": {
            const ver = str(rest[0]);
            started.count++;
            out(`wsastartup ${ver} -> ret=0 err=0 ver=2.2 high=2.2`);
            return;
        }
        case verb === "wsacleanup": out("wsacleanup -> ret=0 err=0"); return;
        case verb === "wsasetlasterror": out(`${verb} ${str(rest[0])} -> ret=0`); return;
        case verb === "socket": {
            const af = str(rest[0]), type = str(rest[1]), proto = str(rest[2]);
            const prefix = `socket ${af} ${type} ${proto}`;
            try {
                const sid = table.socket(intOf(type) ?? 1, intOf(af) ?? 2, intOf(proto) ?? 0);
                syms.set(assigned!, { sid, open: true });
                out(`${prefix} -> ret=${assigned} err=0`);
            } catch (error) { hrLine(prefix, -1); out(`${prefix} -> ret=-1 err=${errName(failCode(error))}`); }
            return;
        }
        case verb === "closesocket": {
            const sid = socketId(0)!;
            const prefix = `closesocket ${str(rest[0])}`;
            let hr = 0;
            try { hr = table.closesocket(sid); } catch (error) { hr = -failCode(error); }
            if (hr === 0) { syms.get(str(rest[0]))!.open = false; out(`${prefix} -> ret=0 err=0`); }
            else hrLine(prefix, hr);
            return;
        }
        case verb === "bind": {
            const sid = socketId(0)!;
            const target = addrOf(1)!;
            const prefix = `bind ${str(rest[0])} ${str(rest[1])}`;
            let hr = 0;
            try { hr = table.bind(sid, target); } catch (error) { hr = -failCode(error); }
            if (hr === 0) {
                const local = socketPortTag(sid)!;
                syms.get(str(rest[0]))!.addr = local;
                out(`${prefix} -> ret=0 err=0 addr=${appendAddr(local)}`);
            } else hrLine(prefix, hr);
            return;
        }
        case verb === "udp_open_port" || verb === "udp_closed_port": {
            if (!assigned) { out(`error udp_open_port/udp_closed_port requires assignment`); return; }
            const sid = table.socket(2, 2, 17);
            const target = ipv4Address(Uint8Array.of(127, 0, 0, 1), 0);
            const hr = table.bind(sid, target);
            if (hr !== 0) { hrLine(verb, hr); return; }
            const local = socketPortTag(sid)!;
            const sym: Symbol = { sid, addr: local, open: true };
            syms.set(assigned, sym);
            out(`${verb} -> ret=${assigned} err=0 addr=${appendAddr(local)}`);
            if (!verb.endsWith("open_port")) { table.closesocket(sid); sym.open = false; }
            return;
        }
        case verb === "getsockname" || verb === "getpeername": {
            const sid = socketId(0)!;
            const prefix = `${verb} ${str(rest[0])}`;
            let addr: WsaAddress | undefined;
            try { addr = (table.get(sid) as { local?: WsaAddress; peer?: WsaAddress })[verb === "getsockname" ? "local" : "peer"] ?? undefined; } catch { addr = undefined; }
            if (addr) {
                syms.get(str(rest[0]))!.addr = verb === "getsockname" ? addr : syms.get(str(rest[0]))!.addr;
                out(`${prefix} -> ret=0 err=0 addr=${appendAddr(addr)}`);
            } else hrLine(prefix, -1);
            return;
        }
        case verb === "listen": {
            const sid = socketId(0)!;
            const prefix = `listen ${str(rest[0])} ${str(rest[1])}`;
            let hr = 0;
            try { hr = table.listen(sid, Number(str(rest[1]))); } catch (error) { hr = -failCode(error); }
            hr === 0 ? out(`${prefix} -> ret=0 err=0`) : hrLine(prefix, hr);
            return;
        }
        case verb === "accept": {
            const sid = socketId(0)!;
            const prefix = `accept ${str(rest[0])}`;
            try {
                const child = table.accept(sid);
                syms.set(assigned!, { sid: child, open: true });
                const from = (table.get(child) as { peer?: WsaAddress }).peer;
                out(`${prefix} -> ret=${assigned} err=0 from=${from ? appendAddr(from) : "?"}`);
            } catch (error) { hrLine(prefix, -1); }
            return;
        }
        case verb === "connect": {
            const sid = socketId(0)!;
            const target = addrOf(1)!;
            const prefix = `connect ${str(rest[0])} ${str(rest[1])}`;
            try {
                const hr = table.connect(sid, target);
                hr === 0 ? out(`${prefix} -> ret=0 err=0`) : hrLine(prefix, hr);
            } catch (error) { hrLine(prefix, -failCode(error)); }
            return;
        }
        case verb === "send": {
            const sid = socketId(0)!;
            const bytes = dataOf(rest[1]);
            const prefix = `send ${str(rest[0])} ${JSON.stringify(str(rest[1]))}`.replace(/^send (\S+) "(.*)"$/, (m, a, b) => `send ${a} "${b}"`);
            try {
                const n = table.send(sid, bytes, undefined, rest[2] ? (str(rest[2]) === "oob" ? 1 : 2) : 0);
                out(`${prefix} -> ret=${n} err=0`);
            } catch (error) { hrLine(prefix, -failCode(error)); }
            return;
        }
        case verb === "recv": {
            const sid = socketId(0)!;
            const size = Number(str(rest[1]));
            const flags = rest[2] ? (str(rest[2]) === "oob" ? 1 : 2) : 0;
            const prefix = `recv ${str(rest[0])} ${str(rest[1])}${rest[2] ? " " + str(rest[2]) : ""}`;
            try {
                const packet = table.receive(sid, size, flags);
                // the Winsock layer surfaces a truncated datagram as SOCKET_ERROR/WSAEMSGSIZE
                if (packet.truncated) out(`${prefix} -> ret=-1 err=WSAEMSGSIZE`);
                else out(`${prefix} -> ret=${packet.data.length} err=0 data=${appendData(packet.data)}`);
            } catch (error) {
                const code = failCode(error);
                if (code === WSA.ECONNRESET) out(`${prefix} -> ret=-1 err=WSAECONNRESET`);
                else hrLine(prefix, -code);
            }
            return;
        }
        case verb === "sendto": {
            const sid = socketId(0)!;
            const target = addrOf(1)!;
            const bytes = dataOf(rest[2]);
            const prefix = `sendto ${str(rest[0])} ${str(rest[1])} ${JSON.stringify(str(rest[2]))}`.replace(/"([^"]*)\"$/, '"$1"');
            try {
                const n = table.sendto(sid, bytes, target);
                out(`${prefix} -> ret=${n} err=0`);
            } catch (error) { hrLine(prefix, -failCode(error)); }
            return;
        }
        case verb === "recvfrom": {
            const sid = socketId(0)!;
            const size = Number(str(rest[1]));
            const flags = rest[2] ? (str(rest[2]) === "peek" ? 2 : 1) : 0;
            const prefix = `recvfrom ${str(rest[0])} ${str(rest[1])}${rest[2] ? " " + str(rest[2]) : ""}`;
            try {
                const packet = table.receive(sid, size, flags);
                if (packet.truncated) out(`${prefix} -> ret=-1 err=WSAEMSGSIZE`);
                else out(`${prefix} -> ret=${packet.data.length} err=0 from=${appendAddr(packet.from)} data=${appendData(packet.data)}`);
            } catch (error) { hrLine(prefix, -failCode(error)); }
            return;
        }
        case verb === "ioctlsocket": {
            const sid = socketId(0)!;
            const cmdName = str(rest[1]);
            const cmd = intOf(cmdName) ?? 0;
            let suffix = "";
            let hr = 0;
            try {
                if (cmd === 0x8004667e) table.setNonBlocking(sid, dataOf(rest[2])[0] !== 0);
                else if (cmd === 0x4004667f) { suffix = ` out=${table.bytesAvailable(sid)}`; }
                else hr = -WSA.EINVAL;
            } catch (error) { hr = -failCode(error); }
            const prefix = `ioctlsocket ${str(rest[0])} ${cmdName}${rest[2] && cmd !== 0x4004667f ? " " + str(rest[2]) : ""}`;
            hr === 0 ? out(`${prefix} -> ret=0 err=0${suffix}`) : hrLine(prefix, hr);
            return;
        }
        case verb === "shutdown": {
            const sid = socketId(0)!;
            const howName = str(rest[1]);
            const prefix = `shutdown ${str(rest[0])} ${howName}`;
            try {
                const hr = table.shutdown(sid, intOf(howName) ?? 2);
                hr === 0 ? out(`${prefix} -> ret=0 err=0`) : hrLine(prefix, hr);
            } catch (error) { hrLine(prefix, -failCode(error)); }
            return;
        }
        case verb === "wsaioctl": {
            const sid = socketId(0)!;
            const cmdName = str(rest[1]);
            let value = 0, hasIn = false;
            for (const t of rest.slice(2)) {
                const text = str(t);
                if (text.startsWith("in=")) { value = dataOf({ ...t, start: text.slice(3), len: text.length - 3, isStr: false })[0]; hasIn = true; }
            }
            const prefix = `wsaioctl ${str(rest[0])} ${cmdName}${rest[2] ? " " + str(rest[2]) : ""}`;
            if (cmdName === "SIO_UDP_CONNRESET") { table.setUdpConnReset(sid, value !== 0); out(`${prefix} -> ret=0 err=0`); }
            else if (cmdName === "SIO_UDP_NETERR") { table.setUdpConnReset(sid, value !== 0); out(`${prefix} -> ret=0 err=0`); }
            else hrLine(prefix, -WSA.EINVAL);
            return;
        }
        case verb === "select": {
            let timeout = 0;
            const sets: Record<"r" | "w" | "e", string[]> = { r: [], w: [], e: [] };
            for (const t of rest) {
                const text = str(t);
                if (text.startsWith("t=")) timeout = Number(text.slice(2));
                else sets[text[0] as "r" | "w" | "e"] = text.slice(2).split(",");
            }
            const deadline = Date.now() + Math.max(0, timeout);
            const ready = { r: [] as string[], w: [] as string[], e: [] as string[] };
            for (;;) {
                for (const key of ["r", "w", "e"] as const) {
                    if (ready[key].length) continue;
                    for (const name of sets[key]) {
                        const sid = syms.get(name)?.sid;
                        if (sid === undefined) continue;
                        const ok = key === "r" ? table.readable(sid) : key === "w" ? table.writable(sid) : table.exceptional?.(sid);
                        if (ok) ready[key].push(name);
                    }
                }
                if (ready.r.length + ready.w.length + ready.e.length > 0 || Date.now() >= deadline) break;
                await sleep(10);
            }
            let prefix = "select";
            for (const t of rest) prefix += ` ${str(t)}`;
            let suffix = "";
            const keyName = { r: "rd", w: "wr", e: "ex" } as const;
            for (const key of ["r", "w", "e"] as const) if (sets[key].length && ready[key].length) suffix += ` ${keyName[key]}=${ready[key].join(",")}`;
            const total = ready.r.length + ready.w.length + ready.e.length;
            out(`${prefix} -> ret=${total} err=0${suffix}`);
            return;
        }
        default:
            out(`error unknown verb ${verb}`);
    }
}

function casePaths(caseId: string) {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(caseId)) throw new Error(`Case id must be <area>/<name>: ${caseId}`);
    return {
        script: join(casesRoot, caseId + ".lp"),
        golden: join(casesRoot, caseId + ".native.log"),
    };
}

async function runCase(caseId: string): Promise<string> {
    const { script } = casePaths(caseId);
    network = new LanNetwork(Uint8Array.of(2, 0, 0, 0, 0, 1));
    table = new WsaSocketTable(network);
    syms.clear(); lines.length = 0; started.count = 0;
    const text = readFileSync(script, "utf8");
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        await execute(line);
    }
    out(`exit 0`);
    return lines.join("\n") + "\n";
}

const [cmd, caseId] = process.argv.slice(2);
if ((cmd !== "run" && cmd !== "check") || !caseId) {
    console.error("usage: lp-fast.ts run|check <area>/<case>");
    process.exit(2);
}
const log = await runCase(caseId);
if (cmd === "run") {
    console.log(log);
} else {
    const { golden } = casePaths(caseId);
    if (!existsSync(golden)) { console.error(`FAIL ${caseId}: no golden ${golden}`); process.exit(1); }
    const goldenLines = readFileSync(golden, "utf8").split("\n").filter(l => l.length);
    const guestLines = log.split("\n").filter(l => l.length);
    const differences: Array<{ line: number; native: string; guest: string }> = [];
    for (let i = 0; i < Math.max(goldenLines.length, guestLines.length); i++) {
        if (goldenLines[i] !== guestLines[i]) differences.push({ line: i + 1, native: goldenLines[i] ?? "<missing>", guest: guestLines[i] ?? "<missing>" });
    }
    if (!differences.length) {
        console.log(`OK ${caseId} (${goldenLines.length} lines, fast path)`);
    } else {
        console.log(`DIFF ${caseId}: ${differences.length} differing line(s)`);
        for (const d of differences.slice(0, 20)) {
            console.log(`  line ${d.line}`);
            console.log(`    native: ${d.native}`);
            console.log(`    guest : ${d.guest}`);
        }
        process.exitCode = 1;
    }
}
