import { createSocket } from "node:dgram";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { decodeNativeProtocolFrame, DN } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
import { NativeReceiveWindow } from "../../src/worker/modules/dpnet/native-wire/receive-window";
import { decodeNativeCoreConnectInfo, decodeNativePlayerConnect } from "../../src/worker/modules/dpnet/native-wire/core-connect-codec";
import { decodeNativeCoreOperation } from "../../src/worker/modules/dpnet/native-wire/core-operations";

if (process.platform !== "win32") throw new Error("Three real Windows DirectPlay processes required");
const nonce = Date.now() >>> 0, root = resolve("logs/lan-conformance/directplay8-mesh", String(nonce));
mkdirSync(root, { recursive: true }); mkdirSync(join(root, "packets"));
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const save = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value, null, 2) + "\n");
const events: unknown[] = [];
const note = (kind: string, value: unknown = null) => { events.push({ at: new Date().toISOString(), kind, value }); save("progress.json", events); };
const roles = ["host", "peer1", "peer2"] as const;
interface Child { role: number; pid: number; cwd: string; proc: ReturnType<typeof Bun.spawn>; exit: number | null; output: Promise<void>; }
const children: Child[] = [];
const reserved: ReturnType<typeof createSocket>[] = [];
let ports: number[] = [], failure: string | null = null;
const compiler = "C:/msys64/mingw32/bin/gcc.exe", executable = join(root, "mesh.exe");
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
environment.Path = dirname(compiler) + ";" + (process.env.Path ?? process.env.PATH ?? "");
const deadline = Date.now() + 35000;
const mark = (child: Child, name: string) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(nonce); writeFileSync(join(child.cwd, name), bytes); };
const marked = (child: Child, name: string) => {
    try { const b = readFileSync(join(child.cwd, name)); return b.length === 4 && b.readUInt32LE() === nonce; } catch { return false; }
};
async function waitFor(check: () => boolean, label: string, milliseconds = 10000) {
    const end = Math.min(deadline, Date.now() + milliseconds);
    while (!check()) {
        const dead = children.find(child => child.exit !== null);
        if (dead) throw new Error(label + ": " + roles[dead.role] + " exited " + dead.exit);
        if (Date.now() > end) throw new Error(label + " timeout");
        await Bun.sleep(5);
    }
    note(label);
}
function start(role: number): Child {
    const cwd = join(root, roles[role]); mkdirSync(cwd);
    const proc = Bun.spawn([executable, "--" + roles[role]], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    const child: Child = { role, pid: proc.pid, cwd, proc, exit: null, output: Promise.resolve() };
    child.output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([out, error]) => {
        writeFileSync(join(cwd, "stdout.txt"), out); writeFileSync(join(cwd, "stderr.txt"), error);
    });
    void proc.exited.then(code => { child.exit = code; note("exit", { role, pid: child.pid, code }); });
    children.push(child); note("spawn", { role, pid: child.pid }); return child;
}
function words(path: string): number[] {
    const bytes = readFileSync(path); if (bytes.length % 4) throw new Error("Unaligned record " + path);
    return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
}
try {
    note("begin", { nonce, source: sha(readFileSync("tools/lan-conformance/directplay8-mesh.c")) });
    for (let attempt = 0; attempt < 32 && !ports.length; attempt++) {
        try {
            const first = createSocket("udp4"); reserved.push(first);
            await new Promise<void>((ok, bad) => { first.once("error", bad); first.bind(0, "127.0.0.1", ok); });
            const base = first.address().port; if (base > 65533) throw new Error("Port range");
            for (const port of [base + 1, base + 2]) {
                const socket = createSocket("udp4"); reserved.push(socket);
                await new Promise<void>((ok, bad) => { socket.once("error", bad); socket.bind(port, "127.0.0.1", ok); });
            }
            ports = [base, base + 1, base + 2];
        } catch { for (const socket of reserved.splice(0)) { try { socket.close(); } catch {} } }
    }
    if (!ports.length) throw new Error("No three free loopback UDP ports");
    const argv = [compiler, "-O1", "-Wall", "-Wextra", "-Werror", "-Wno-misleading-indentation", "-nostdlib", "-fno-builtin", "-fno-stack-protector",
        "-DORACLE_NONCE=" + nonce, "-DORACLE_HOST_PORT=" + ports[0], "-Wl,--entry,_entry", "-Wl,--subsystem,console",
        "-o", executable, "tools/lan-conformance/directplay8-mesh.c", "-lkernel32", "-lole32", "-ldxguid", "-luuid", "-lws2_32"];
    const build = Bun.spawnSync(argv, { env: environment, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(root, "compiler.stdout.txt"), build.stdout); writeFileSync(join(root, "compiler.stderr.txt"), build.stderr);
    save("build.json", { nonce, ports, argv, exit: build.exitCode });
    if (build.exitCode) throw new Error("Native compilation failed: " + new TextDecoder().decode(build.stderr));
    copyFileSync("tools/lan-conformance/directplay8-mesh.c", join(root, "fixture.c"));
    note("built", { executableSha256: sha(readFileSync(executable)), ports });
    for (const socket of reserved.splice(0)) await new Promise<void>(done => socket.close(() => done()));
    const host = start(0); await waitFor(() => marked(host, "mesh-ready.bin"), "host-ready");
    const first = start(1); await waitFor(() => marked(first, "mesh-ready.bin"), "peer1-ready");
    const second = start(2); await waitFor(() => marked(second, "mesh-ready.bin"), "peer2-ready");
    await waitFor(() => children.every(child => marked(child, "mesh-full.bin")), "all-three-created");
    children.forEach(child => mark(child, "mesh-go.bin"));
    await waitFor(() => children.every(child => marked(child, "mesh-metrics.bin")), "direct-peer-exchange");
    for (const child of [second, first, host]) {
        mark(child, "mesh-close.bin");
        const end = Date.now() + 4000;
        while (child.exit === null && Date.now() < end) await Bun.sleep(5);
        if (child.exit !== 0) throw new Error(roles[child.role] + " close failed " + child.exit);
    }
    await Promise.all(children.map(child => child.output));
    const records = children.map(child => {
        const observation = words(join(child.cwd, "lan-oracle.bin")), state = words(join(child.cwd, "mesh-state.bin"));
        if (observation[0] !== 0x42534c4e || observation[1] !== observation.length || observation[2] !== nonce || observation.at(-1) !== 0) throw new Error("Invalid final observations " + child.role);
        if (state.length !== 18 || state[0] !== 0x42534d53 || state[1] !== nonce || state[2] !== child.role ||
            state[3] !== 7 || state[4] || state[5] || state.slice(9, 15).some(value => value !== 1)) throw new Error("Native callback state mismatch " + JSON.stringify(state));
        if (child.role && state[15 + 3 - child.role] !== 1) throw new Error("Direct peer RECEIVE missing");
        return { role: child.role, pid: child.pid, observations: observation.slice(3), ids: state.slice(6, 9), creates: state.slice(9, 12), destroys: state.slice(12, 15), receives: state.slice(15, 18) };
    });
    save("native-state.json", { nonce, ports, records });
    const ids = records[0].ids;
    if (new Set(ids).size !== 3 || records.some(record => record.ids.some((id, i) => id !== ids[i]))) throw new Error("Role IDs disagree across processes");
    const normalize = (id: number) => { const i = ids.indexOf(id); return i >= 0 ? roles[i] : id; };
    const packets: unknown[] = [], messages: { source: number; target: number; command: number; payload: string; core?: number; decoded?: unknown }[] = [];
    const flows = new Map<string, NativeReceiveWindow>(), sockets = new Map<number, Set<number>>();
    for (const child of children) {
        const raw = readFileSync(join(child.cwd, "mesh-wire.bin")), head = Array.from({ length: 9 }, (_, i) => raw.readUInt32LE(i * 4));
        if (head[0] !== 0x42534d54 || head[1] !== 3 || head[2] !== nonce || head[3] !== child.role || head[4] !== 1 ||
            head[6] !== 0 || head[7] !== 27 || head[8] !== 4096 || raw.length !== 36 + head[5] * (108 + 4096)) throw new Error("Incomplete native wire trace " + child.role);
        for (let i = 0; i < head[5]; i++) {
            const offset = 36 + i * 4204, meta = Array.from({ length: 27 }, (_, n) => raw.readUInt32LE(offset + n * 4));
            const bytes = raw.subarray(offset + 108, offset + 108 + meta[8]), target = ports.indexOf(meta[6]);
            if (meta[7] !== meta[8]) throw new Error("Truncated packet");
            if (meta[13] !== 2 || meta[14] !== 2 || meta[5] !== 0x0100007f || target < 0) throw new Error("Non-loopback/unknown destination: " + JSON.stringify({ source: child.role, packet: i, meta }));
            if (meta[4] !== ports[child.role]) throw new Error("Source UDP port changed between peers");
            if (meta[11] !== 0 && meta[12] !== 997) throw new Error("WSASendTo failed " + meta[12]);
            const set = sockets.get(child.role) ?? new Set<number>(); set.add(meta[2]); sockets.set(child.role, set);
            const path = "packets/" + child.role + "-" + target + "-" + i + ".bin"; writeFileSync(join(root, path), bytes);
            const frame = decodeNativeProtocolFrame(bytes);
            packets.push({ source: child.role, target, tick: meta[0], socket: meta[2], sourcePort: meta[4], destinationPort: meta[6], path, sha256: sha(bytes), frame });
            if (frame?.kind !== "data") continue;
            const key = child.role + ":" + target, window = flows.get(key) ?? new NativeReceiveWindow(); flows.set(key, window);
            for (const message of window.receive(frame).messages) {
                const core = message.command & DN.USER1 && message.payload.length >= 4 ? new DataView(message.payload.buffer).getUint32(0, true) : undefined;
                let decoded: unknown;
                if (core === 0xc1) decoded = decodeNativePlayerConnect(message.payload);
                if (core === 0xc2) decoded = decodeNativeCoreConnectInfo(message.payload);
                if (core !== undefined && decoded === undefined) decoded = decodeNativeCoreOperation(message.payload);
                messages.push({ source: child.role, target, command: message.command, payload: Buffer.from(message.payload).toString("hex"), core, decoded });
            }
        }
    }
    if ([0, 1, 2].some(role => sockets.get(role)?.size !== 1)) throw new Error("Expected one physical socket per role");
    for (const [source, target] of [[1, 2], [2, 1]]) {
        if (!messages.some(message => message.source === source && message.target === target && !(message.command & DN.USER1) &&
            message.payload === "4d0" + source + "37" + (source ^ 0x5a).toString(16))) throw new Error("No direct peer wire payload " + source);
    }
    save("messages.json", messages);
    save("packets.json", packets);
    save("native-reference.json", { nonce, ports, records, normalized: records.map(record => ({ ...record, ids: record.ids.map(normalize) })), sockets: [...sockets].map(([role, values]) => ({ role, sockets: [...values], sourcePort: ports[role] })), messages: messages.length, packets: packets.length });
    note("verified", { records: records.length, messages: messages.length, packets: packets.length });
} catch (error) {
    failure = String(error); note("failure", failure); process.exitCode = 1;
} finally {
    for (const socket of reserved.splice(0)) { try { socket.close(); } catch {} }
    for (const child of children) if (child.exit === null) { try { mark(child, "mesh-close.bin"); } catch {} }
    const end = Date.now() + 1000;
    while (children.some(child => child.exit === null) && Date.now() < end) await Bun.sleep(5);
    for (const child of children) if (child.exit === null) child.proc.kill();
    await Promise.all(children.map(child => child.proc.exited));
    await Promise.all(children.map(child => child.output));
    save("result.json", { nonce, root, ports, failure, children: children.map(child => ({ role: child.role, pid: child.pid, exit: child.exit })) });
    console.log(JSON.stringify({ root, nonce, ports, failure, sourceSha256: sha(readFileSync("tools/lan-conformance/directplay8-mesh.c")) }));
}
