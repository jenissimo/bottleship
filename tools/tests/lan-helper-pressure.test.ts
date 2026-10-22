// Real loopback-only native sockets: exercise send pressure, control results and receive credit.
import { beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeHelperSocket } from "../../packages/lan/src/native-helper";
import { buildNativeForTests, nativeTestHelper } from "../../packages/lan/native/testing";
import { TCP_SEGMENT, TCP_WINDOW } from "../../packages/lan/src/tcp-protocol";

// The peer has a small native receive window and never calls recv before drainend.
// Its reverse writes, MSG_OOB, receive count and hash all use actual OS sockets.
const PEER_SOURCE = String.raw`/* Test-only native pressure peer. No recv until an explicit drain command. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET socket_t;
#define CLOSE closesocket
#define LAST_ERROR() WSAGetLastError()
#else
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
typedef int socket_t;
#define INVALID_SOCKET (-1)
#define CLOSE close
#define LAST_ERROR() errno
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *where) {
    fprintf(stderr,"%s: %d\n",where,LAST_ERROR());fflush(stderr);return 1;
}
static int send_all(socket_t peer,const unsigned char *data,unsigned size,int flags) {
    while(size) {
        int sent=send(peer,(const char*)data,(int)size,flags);
        if(sent<=0)return 0;
        data+=sent;size-=(unsigned)sent;
    }
    return 1;
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;if(WSAStartup(MAKEWORD(2,2),&wsa))return 2;
#else
    signal(SIGPIPE,SIG_IGN);
#endif
    socket_t listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    int receive_buffer=4096;
    if(listener==INVALID_SOCKET||setsockopt(listener,SOL_SOCKET,SO_RCVBUF,(const char*)&receive_buffer,sizeof(receive_buffer)))return fail("receive buffer");
    struct sockaddr_in address;memset(&address,0,sizeof(address));
    address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    if(bind(listener,(struct sockaddr*)&address,sizeof(address))||listen(listener,1))return fail("listen");
#ifdef _WIN32
    int address_size=sizeof(address);
#else
    socklen_t address_size=sizeof(address);
#endif
    if(getsockname(listener,(struct sockaddr*)&address,&address_size))return fail("local address");
    printf("{\"port\":%u}\n",(unsigned)ntohs(address.sin_port));fflush(stdout);
    socket_t peer=accept(listener,NULL,NULL);CLOSE(listener);
    if(peer==INVALID_SOCKET)return fail("accept");
    if(setsockopt(peer,SOL_SOCKET,SO_RCVBUF,(const char*)&receive_buffer,sizeof(receive_buffer)))return fail("accepted receive buffer");
#ifdef _WIN32
    DWORD timeout=15000;
#else
    struct timeval timeout={15,0};
#endif
    if(setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,sizeof(timeout))||setsockopt(peer,SOL_SOCKET,SO_SNDTIMEO,(const char*)&timeout,sizeof(timeout)))return fail("deadline");
    printf("{\"accepted\":true}\n");fflush(stdout);
    unsigned long long total=0;
    uint32_t hash=2166136261u;
    char line[128],operation[32];
    unsigned id=0,length=0,value=0;
    unsigned char bytes[16384];
    while(fgets(line,sizeof(line),stdin)) {
        int fields=sscanf(line,"%31s %u %u %u",operation,&id,&length,&value);
        if(fields<2)return 3;
        if(!strcmp(operation,"send")&&fields==4) {
            memset(bytes,(unsigned char)value,sizeof(bytes));
            while(length) {
                unsigned part=length<sizeof(bytes)?length:(unsigned)sizeof(bytes);
                if(!send_all(peer,bytes,part,0))return fail("send");
                length-=part;
            }
            printf("{\"id\":%u,\"sent\":true}\n",id);fflush(stdout);
        } else if(!strcmp(operation,"urgent")&&fields==3) {
            unsigned char byte=(unsigned char)length;
            if(!send_all(peer,&byte,1,MSG_OOB))return fail("urgent send");
            printf("{\"id\":%u,\"urgent\":true}\n",id);fflush(stdout);
        } else if(!strcmp(operation,"abort")&&fields==2) {
            struct linger abortive={1,0};
            if(setsockopt(peer,SOL_SOCKET,SO_LINGER,(const char*)&abortive,sizeof(abortive)))return fail("abort linger");
            CLOSE(peer);
            printf("{\"id\":%u,\"aborted\":true}\n",id);fflush(stdout);return 0;
        } else if(!strcmp(operation,"drainend")&&fields==2) {
            for(;;) {
                int received=recv(peer,(char*)bytes,sizeof(bytes),0);
                if(received<0)return fail("drain");
                if(!received)break;
                total+=(unsigned)received;
                for(int index=0;index<received;index++)hash=(hash^bytes[index])*16777619u;
            }
#ifdef _WIN32
            if(shutdown(peer,SD_SEND))return fail("shutdown");
#else
            if(shutdown(peer,SHUT_WR))return fail("shutdown");
#endif
            printf("{\"id\":%u,\"eof\":true,\"total\":%llu,\"hash\":%u}\n",id,total,(unsigned)hash);fflush(stdout);
            CLOSE(peer);return 0;
        } else return 4;
    }
    CLOSE(peer);return 0;
}
`;
const buildDirectory = fileURLToPath(new URL("../../packages/lan/native/build/", import.meta.url));
const peerExecutable = join(buildDirectory, "test-pressure-peer-" + createHash("sha256").update(PEER_SOURCE).digest("hex").slice(0, 12) + (process.platform === "win32" ? ".exe" : ""));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MAX_WARMUP_BYTES = 16 * 1024 * 1024;
const STEP_TIMEOUT = 10_000;
type Control = { id: number; option: 0 | 1 | 2; enabled: boolean };
type Option = { option: number; enabled: boolean };
type PeerReply = { id?: number; port?: number; accepted?: boolean; aborted?: boolean; eof?: boolean; total?: number; hash?: number };

async function until(check: () => boolean, label: string, healthy: () => void = () => {}, timeout = STEP_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!check()) {
        healthy();
        if (Date.now() >= deadline) throw new Error("Timeout: " + label);
        await pause(2);
    }
    healthy();
}

async function buildPeer(): Promise<void> {
    try { await access(peerExecutable); return; } catch {}
    await mkdir(buildDirectory, { recursive: true });
    const sourcePath = peerExecutable + ".c";
    await writeFile(sourcePath, PEER_SOURCE);
    const compiler = process.env.BS_LAN_CC ?? (process.platform === "win32" ? "C:/msys64/mingw64/bin/gcc.exe" : "cc");
    const compilerEnv = { ...process.env };
    if (process.platform === "win32") {
        for (const key of Object.keys(compilerEnv)) if (key.toLowerCase() === "path") delete compilerEnv[key];
        compilerEnv.Path = dirname(compiler) + ";" + (process.env.PATH ?? process.env.Path ?? "");
    }
    const compilerChild = spawn(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", peerExecutable,
        ...(process.platform === "win32" ? ["-D_WIN32_WINNT=0x0601", "-lws2_32"] : [])],
        { stdio: ["ignore", "pipe", "pipe"], env: compilerEnv, windowsHide: true });
    let diagnostics = "";
    compilerChild.stdout.resume();
    compilerChild.stderr.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-8192); });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { compilerChild.kill(); reject(new Error("Pressure peer compilation timed out")); }, 30_000);
        compilerChild.on("error", error => { clearTimeout(timer); reject(error); });
        compilerChild.on("close", code => {
            clearTimeout(timer);
            if (code === 0) resolve(); else reject(new Error("Pressure peer compilation failed: " + diagnostics));
        });
    });
}

beforeAll(async () => { await buildNativeForTests(); await buildPeer(); }, 60_000);

class PressurePeer {
    readonly child: ChildProcessWithoutNullStreams;
    readonly exited: Promise<void>;
    readonly replies = new Map<number, PeerReply>();
    port = 0;
    accepted = false;
    private nextId = 1;
    private failure: Error | null = null;
    private stopped = false;
    private output = "";
    private diagnostics = "";
    constructor() {
        this.child = spawn(peerExecutable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.child.stdout.on("data", bytes => {
            this.output += String(bytes);
            if (this.output.length > 65536) { this.failure = new Error("Pressure peer output overflow"); return; }
            for (;;) {
                const end = this.output.indexOf("\n");
                if (end < 0) break;
                const line = this.output.slice(0, end); this.output = this.output.slice(end + 1);
                try {
                    const reply = JSON.parse(line) as PeerReply;
                    if (reply.port) this.port = reply.port;
                    if (reply.accepted) this.accepted = true;
                    if (reply.id !== undefined) this.replies.set(reply.id, reply);
                } catch (error) { this.failure = error as Error; }
            }
        });
        this.child.stderr.on("data", bytes => { this.diagnostics = (this.diagnostics + String(bytes)).slice(-8192); });
        this.child.stdin.on("error", error => { if (!this.stopped) this.failure = error; });
        this.child.on("error", error => { this.failure = error; });
        this.exited = new Promise<void>(resolve => this.child.on("close", code => {
            if (!this.stopped && code !== 0) this.failure = new Error("Pressure peer exit " + code + ": " + this.diagnostics);
            resolve();
        }));
    }
    healthy = (): void => { if (this.failure) throw this.failure; };
    async command(operation: string, ...args: number[]): Promise<PeerReply> {
        const id = this.nextId++;
        this.child.stdin.write([operation, id, ...args].join(" ") + "\n");
        await until(() => this.replies.has(id), "peer " + operation, this.healthy, operation === "drainend" ? 30_000 : STEP_TIMEOUT);
        const reply = this.replies.get(id)!; this.replies.delete(id);
        return reply;
    }
    async close(): Promise<void> {
        this.stopped = true;
        this.child.stdin.destroy();
        this.child.kill();
        await new Promise<void>((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error("Pressure peer failed to terminate")),2000);
            void this.exited.then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);reject(error);});
        });
    }
}

class PressureConnection {
    readonly helper = new NativeHelperSocket(nativeTestHelper);
    readonly controls: Control[] = [];
    readonly options: Option[] = [];
    readonly pending = new Set<{ length: number }>();
    connected = false;
    finished = false;
    acceptedBytes = 0;
    hash = 2166136261 >>> 0;
    private failure: Error | null = null;
    private barrierEnabled = false;
    constructor(readonly peer: PressurePeer) {
        this.helper.on("error", error => { this.failure ??= error as Error; });
        this.helper.on("connect", () => { this.connected = true; });
        this.helper.on("control", (control: Control) => this.controls.push(control));
        this.helper.on("option", (option: Option) => this.options.push(option));
    }
    healthy = (): void => { this.peer.healthy(); if (this.failure) throw this.failure; };
    async open(): Promise<void> {
        await until(() => this.peer.port > 0, "native pressure peer listening", this.healthy);
        this.helper.connect(this.peer.port, "127.0.0.1");
        await until(() => this.connected && this.peer.accepted, "native pressure connection", this.healthy);
    }
    write(bytes: Uint8Array): void {
        const record = { length: bytes.length };
        this.pending.add(record);
        const accepted = this.helper.write(bytes, error => {
            this.pending.delete(record);
            if (error) this.failure ??= error;
        });
        if (!accepted) {
            this.pending.delete(record);
            throw new Error("Unexpected pressure write rejection at " + this.pending.size + " pending records");
        }
        this.acceptedBytes += bytes.length;
        for (const byte of bytes) this.hash = Math.imul(this.hash ^ byte, 16777619) >>> 0;
    }
    async control(option: 0 | 1 | 2, enabled: boolean): Promise<void> {
        const start = this.controls.length, optionStart = this.options.length;
        if (option === 0) this.helper.setOobInline(enabled);
        else if (option === 1) this.helper.setKeepAlive(enabled);
        else this.helper.setNoDelay(enabled);
        await until(() => this.controls.slice(start).some(event => event.option === option && event.enabled === enabled && event.id > 0),
            "native control applied " + option + "=" + enabled, this.healthy);
        if (option !== 0) expect(this.options.slice(optionStart).some(event => event.option === option && event.enabled === enabled)).toBe(true);
    }
    async readExactly(length: number): Promise<Buffer> {
        const result = Buffer.alloc(length);
        let offset = 0;
        const deadline = Date.now() + STEP_TIMEOUT;
        while (offset < length) {
            this.healthy();
            const part = this.helper.read(Math.min(7777, length - offset));
            if (part) { part.copy(result, offset); offset += part.length; }
            else {
                if (Date.now() >= deadline) throw new Error("Timeout: pressure reverse stream, read " + offset + "/" + length);
                await pause(2);
            }
        }
        return result;
    }
    async progressBarrier(): Promise<void> {
        this.barrierEnabled = !this.barrierEnabled;
        // The control ACK proves the input parser admitted preceding DATA.
        await this.control(2, this.barrierEnabled);
        // A subsequent real socket read crosses a main-loop send attempt.
        // A still-pending write callback at this point is native backpressure,
        // rather than a DATA frame merely waiting in the parent's stdin queue.
        await this.peer.command("send", 1, 0x31);
        expect(await this.readExactly(1)).toEqual(Buffer.of(0x31));
    }
    async blockNativeHead(): Promise<void> {
        const segment = Buffer.alloc(TCP_SEGMENT, 0x5a);
        for (let sent = 0; sent < MAX_WARMUP_BYTES; sent += segment.length) {
            expect(this.pending.size).toBe(0);
            this.write(segment);
            await this.progressBarrier();
            if (this.pending.size) {
                expect(this.pending.size).toBe(1);
                return;
            }
        }
        throw new Error("Native send did not backpressure within bounded 16MiB warmup");
    }
    end(): void {
        this.helper.end(() => { this.finished = true; });
    }
    async verifyControlsAndCredit(): Promise<void> {
        await this.control(1, true);
        await this.control(2, true);
        await this.control(0, true);
        expect(this.pending.size).toBeGreaterThan(0);
        await this.peer.command("urgent", 0xa7);
        expect(await this.readExactly(1)).toEqual(Buffer.of(0xa7));
        expect(this.helper.urgentReady).toBe(false);
        await this.control(0, false);
        await this.peer.command("urgent", 0xa8);
        await until(() => this.helper.urgentReady, "native out-of-line urgent while send blocked", this.healthy);
        expect(this.helper.takeUrgent()).toBe(0xa8);
        expect(this.helper.readableLength).toBe(0);
        expect(this.pending.size).toBeGreaterThan(0);

        // Exhaust every receive token, then leave a distinct byte in the native
        // socket. Its delivery must require CREDIT behind the blocked sends.
        await this.peer.command("send", TCP_WINDOW, 0x43);
        await until(() => this.helper.readableLength === TCP_WINDOW, "reverse receive window filled", this.healthy);
        await this.peer.command("send", 1, 0xd3);
        await this.control(2, false);
        expect(this.helper.readableLength).toBe(TCP_WINDOW);
        expect(await this.readExactly(TCP_WINDOW)).toEqual(Buffer.alloc(TCP_WINDOW, 0x43));
        expect(await this.readExactly(1)).toEqual(Buffer.of(0xd3));
        expect(this.pending.size).toBeGreaterThan(0);
        expect(this.finished).toBe(false);
    }
    async drainAndVerify(): Promise<void> {
        const reply = await this.peer.command("drainend");
        await until(() => this.finished && this.pending.size === 0, "all native sends and FIN completed", this.healthy);
        expect(reply.eof).toBe(true);
        expect(reply.total).toBe(this.acceptedBytes);
        expect(reply.hash).toBe(this.hash);
        this.healthy();
    }
}

async function withPressure(run: (connection: PressureConnection) => Promise<void>): Promise<void> {
    const peer = new PressurePeer(), connection = new PressureConnection(peer);
    try {
        await connection.open();
        await connection.blockNativeHead();
        await run(connection);
    } finally {
        connection.helper.destroy();
        await peer.close();
    }
}

test("native helper reports peer reset without receive credit or an outbound write", async () => {
    const peer = new PressurePeer(), connection = new PressureConnection(peer);
    let error: (Error & { code?: number }) | undefined;
    connection.helper.on("error", failure => { error = failure as Error & { code?: number }; });
    try {
        await connection.open();
        await peer.command("send", TCP_WINDOW, 0x6d);
        await until(() => connection.helper.readableLength === TCP_WINDOW, "receive credit exhausted before reset", connection.healthy);
        expect(connection.pending.size).toBe(0);
        expect((await peer.command("abort")).aborted).toBe(true);
        // No read or write can wake the helper here: the OS close event itself
        // must publish the reset while the parent withholds every receive token.
        await until(() => error !== undefined, "native reset without credit", peer.healthy);
        // Windows reports native WSAECONNABORTED or WSAECONNRESET for an
        // abortive peer close; retain that observed code rather than remap it.
        expect([10053, 10054]).toContain(error?.code);
    } finally {
        connection.helper.destroy();
        await peer.close();
    }
}, 30_000);

for (const shape of ["payload-window", "record-window"] as const) test("native helper " + shape + ": blocked DATA permits controls/CREDIT and FIN preserves every accepted byte", async () => {
    await withPressure(async connection => {
        // The existing, proven-blocked 16KiB warmup record is the first record.
        // No drain occurs until the final stream ledger is checked.
        if (shape === "payload-window") {
            for (let index = 1; index < TCP_WINDOW / TCP_SEGMENT; index++) connection.write(Buffer.alloc(TCP_SEGMENT, 0x5a));
            expect(connection.pending.size).toBe(TCP_WINDOW / TCP_SEGMENT);
        } else {
            for (let index = 1; index < 256; index++) connection.write(Buffer.of(0x61));
            expect(connection.pending.size).toBe(256);
        }
        connection.end();
        await connection.verifyControlsAndCredit();
        await connection.drainAndVerify();
    });
}, 60_000);

test("native helper split preflight rejects an over-record write atomically before native DATA or FIN", async () => {
    await withPressure(async connection => {
        for (let index = 1; index < 255; index++) connection.write(Buffer.of(0x61));
        expect(connection.pending.size).toBe(255);
        let rejected: Error & { code?: number } | undefined;
        const accepted = connection.helper.write(Buffer.alloc(TCP_SEGMENT * 2, 0xe3), error => { rejected = error ?? undefined; });
        expect(accepted).toBe(false);
        await until(() => rejected !== undefined, "over-record rejection callback", connection.healthy);
        expect(rejected?.code).toBe(10055);
        expect(connection.pending.size).toBe(255);
        // The rejected two-segment call must leave the final slot usable.
        connection.write(Buffer.of(0x7b));
        expect(connection.pending.size).toBe(256);
        connection.end();
        await connection.progressBarrier();
        expect(connection.finished).toBe(false);
        expect(connection.pending.size).toBeGreaterThan(0);
        await connection.drainAndVerify();
    });
}, 60_000);
