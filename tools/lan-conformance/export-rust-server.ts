/**
 * Source-only export of the Rust LAN server into a new/empty directory.
 * No install, compilation, Git, service startup or publication is performed.
 * Usage from the BottleShip worktree:
 *   bun tools/lan-conformance/export-rust-server.ts --out ../bottleship-multiplayer-server
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "../..");
const rustRoot = join(projectRoot, "packages/lan-rust");
const helperRoot = join(projectRoot, "packages/lan/native");
const helperFiles = [
    ".gitignore", "README.md", "build.ts", "build-udp.ts", "socket-helper.c", "tcp-io.h",
    "udp-bound-helper.c", "smoke.py", "test-checksum.c", "test-peer.c", "test-udp-tuple.c", "testing.ts",
] as const;
const deniedDirectories = new Set([
    "target", ".git", ".cargo", ".claude", "node_modules", ".cache", "cache", "caches",
    "__pycache__", "logs", "build", "dist", "coverage", ".idea", ".vscode", "credentials", "secrets",
]);
const binarySuffix = /\.(?:exe|dll|pdb|obj|o|a|lib|rlib|rmeta|exp|pch|so|dylib|wasm|zip|7z|gz|xz|pyc|tsbuildinfo)$/i;
const secretName = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|credentials(?:\..*)?|tokens?(?:\.json)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i;
const secretSuffix = /\.(?:pem|key|p12|pfx|jks)$/i;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const unix = (path: string) => path.split(sep).join("/");
const inside = (parent: string, child: string) => {
    const value = relative(parent, child);
    return value === "" || (!value.startsWith(".." + sep) && value !== ".." && !isAbsolute(value));
};
type Source = { path: string; destination: string; bytes: number; sha256: string };
type Output = { path: string; bytes: number; sha256: string; source: string | null; transform?: string };
const ignored: string[] = [];

function permitted(name: string, directory: boolean): boolean {
    if ((name.startsWith(".") && name !== ".gitignore") || secretName.test(name) || secretSuffix.test(name)) return false;
    if (deniedDirectories.has(name.toLowerCase())) return false;
    return directory || !binarySuffix.test(name);
}

async function collect(folder: string, targetPrefix = ""): Promise<Source[]> {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    const result: Source[] = [];
    for (const entry of entries) {
        const source = join(folder, entry.name);
        const output = targetPrefix ? targetPrefix + "/" + entry.name : entry.name;
        if (!permitted(entry.name, entry.isDirectory())) {
            ignored.push(unix(relative(projectRoot, source)));
            continue;
        }
        const status = await lstat(source);
        if (status.isSymbolicLink()) throw new Error("Source links are not exported: " + source);
        if (status.isDirectory()) result.push(...await collect(source, output));
        else if (status.isFile()) {
            const bytes = await readFile(source);
            result.push({ path: unix(relative(projectRoot, source)), destination: output, bytes: bytes.length, sha256: digest(bytes) });
        } else throw new Error("Unsupported source file kind: " + source);
    }
    return result;
}

async function snapshot(): Promise<Source[]> {
    const files = await collect(rustRoot);
    for (const name of helperFiles) {
        const path = join(helperRoot, name);
        const status = await lstat(path);
        if (!status.isFile() || status.isSymbolicLink()) throw new Error("Canonical helper must be a regular file: " + path);
        const bytes = await readFile(path);
        files.push({ path: unix(relative(projectRoot, path)), destination: "native-helper/" + name, bytes: bytes.length, sha256: digest(bytes) });
    }
    const tool = await readFile(scriptPath);
    files.push({ path: unix(relative(projectRoot, scriptPath)), destination: "devtools/export-rust-server.ts", bytes: tool.length, sha256: digest(tool) });
    return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function adapted(path: string, bytes: Uint8Array): { bytes: Uint8Array; transform?: string } {
    if (!path.toLowerCase().endsWith(".md")) return { bytes };
    let text = Buffer.from(bytes).toString("utf8");
    const initial = text;
    text = text.replaceAll("../lan/native", "native-helper").replaceAll("packages/lan/native", "native-helper");
    text = text.replaceAll("packages/lan-rust/", "");
    text = text.replace("Host-listen is a separate future capability.", "Host-listen is an explicit optional capability with configured IPv4 ingress policy and separately fenced native leases.");
    if (path === "README.md") {
        text = text.replace("RAW integration must pass its independent protocol and lifetime checks before being treated as equivalent to the reference.",
            "Measured Windows ICMP echo NAT passed for IPv4 and IPv6 with two participants using the same original identifier. RAW UDP IPv4/IPv6 returned native permission error10013; their successful packet paths are not claimed. Generic raw protocols retain the documented exclusivity and classification limits.");
        text += "\n\nSee STANDALONE.md for the source manifest, optional helper builds, test prerequisites and monorepo-only development tools.\n";
    }
    return text === initial ? { bytes } : { bytes: Buffer.from(text), transform: "standalone-documentation-v1" };
}

const standalone = `# Standalone source export

This directory contains the Rust server, core/native/gateway/transport crates, vendored transport patches, Cargo locks, licenses, notices and source tests. It contains no compiled server/helper binaries or dependency caches. EXPORT-MANIFEST.json records source and exported hashes separately; documentation adaptations are identified there. Export verifies the selected original source inventory and bytes again after copying. A failed/partial export is retained for inspection and is never silently overwritten.

Rust1.94+ is required. From this directory use cargo build --release --locked and cargo test --locked. Crate tests use cargo test --locked --manifest-path core/Cargo.toml (and native/gateway/transport). Cargo obtains pinned registry dependencies separately; the exporter never installs dependencies.

server.example.json is a loopback-only configuration example, including an explicit loopback-host listener and a configured UDP/TCP route. Start it with cargo run --release --locked -- --config server.example.json. It does not start any example game server. Change its native destination, advertised address and permitted peer IPs to the intended installation.

Optional canonical C helper sources and their original build tools are under native-helper/. Apache-2.0 LICENSE and BottleShip NOTICE are included in that directory too. Ordinary UDP/TCP do not require them. To build explicitly, install the local C compiler and Bun, then run bun native-helper/build.ts --tests and bun native-helper/build-udp.ts. BS_LAN_CC selects a compiler. Generated executables stay in native-helper/build/. Configure gateway.nativeHelperPath and gateway.nativeUdpHelperPath with the appropriate measured executable paths. No compiler, helper, elevation or service is started by export.

Gateway integration tests require BOTTLESHIP_RUST_UDP_HELPER pointing to a built/measured bound-UDP executable. Build cargo build --manifest-path gateway/Cargo.toml --example startup_stall, then set BOTTLESHIP_RUST_STARTUP_FIXTURE to gateway/target/debug/examples/startup_stall (with .exe on Windows) before cargo test --manifest-path gateway/Cargo.toml. The startup fixture is adversarial test code, not a production backend. Native probe examples accept explicit helper arguments. Default root cargo test does not automatically execute tests of these path-dependency crates; run each crate explicitly.

The archived devtools/export-rust-server.ts is the original monorepo exporter preserved for provenance; its source-root discovery is not a standalone command. JavaScript files below core/tests/js are development tools for the original BottleShip monorepo. The TS codec-vector generator imports the maintained TS reference package; it requires that checkout. JS Socket.IO black-box utilities require their JS dependencies and a caller-owned server. They are not part of default standalone Cargo tests. The generated Rust wire vectors are included and pure Rust tests use them without importing the emulator or TS runtime.

Native scopes, OS permission failures and asynchronous ICMP behavior remain platform dependent. Actual Windows ICMP4/6 echo NAT and lifecycle tests are distinct from complete RAW or browser DirectPlay Host parity. The measured RAW UDP10013 denial is not a successful UDP packet-path proof. UDP Host listeners are an explicit optional capability, with configured IPv4 source ACLs and bounded owners/learned peers; they do not authorize arbitrary external destinations.

Export does not create an external repository, commit, publish or deploy. Existing TypeScript reference repositories are unaffected.
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let requested: string | undefined;
    if (args.length === 2 && args[0] === "--out") requested = args[1];
    else if (args.length === 1 && !args[0].startsWith("-")) requested = args[0];
    if (!requested) throw new Error("Usage: bun tools/lan-conformance/export-rust-server.ts --out NEW_EMPTY_DIRECTORY");
    const destination = resolve(process.cwd(), requested);
    if (inside(rustRoot, destination) || inside(helperRoot, destination) || inside(destination, rustRoot) || inside(destination, helperRoot))
        throw new Error("Export destination must not overlap source directories");
    try {
        const status = await lstat(destination);
        if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Destination must be a real directory");
        if ((await readdir(destination)).length) throw new Error("Refusing to overwrite a nonempty destination: " + destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(destination, { recursive: true });
    }
    const actualDestination = await realpath(destination);
    if (inside(rustRoot, actualDestination) || inside(helperRoot, actualDestination))
        throw new Error("Resolved destination overlaps source");
    await writeFile(join(destination, "EXPORT-STATE.json"), JSON.stringify({ phase: "copying", started: new Date().toISOString() }, null, 2), { flag: "wx" });
    const before = await snapshot();
    const outputs: Output[] = [];
    const write = async (path: string, bytes: Uint8Array, source: string | null, transform?: string) => {
        const target = resolve(destination, path);
        if (!inside(destination, target)) throw new Error("Output escapes export directory");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
        outputs.push({ path, source, bytes: bytes.length, sha256: digest(bytes), ...(transform ? { transform } : {}) });
    };
    for (const file of before) {
        const source = resolve(projectRoot, file.path);
        const bytes = await readFile(source);
        if (digest(bytes) !== file.sha256) throw new Error("Source changed before copy: " + file.path);
        const output = adapted(file.destination, bytes);
        await write(file.destination, output.bytes, file.path, output.transform);
    }
    await write("STANDALONE.md", Buffer.from(standalone), null, "generated-standalone-guide-v1");
    for (const name of ["LICENSE", "NOTICE"]) {
        const original = before.find(file => file.destination === name);
        if (!original) throw new Error("Missing server " + name);
        const bytes = await readFile(resolve(projectRoot, original.path));
        if (digest(bytes) !== original.sha256) throw new Error("License changed during export");
        await write("native-helper/" + name, bytes, original.path, "helper-license-copy-v1");
    }
    if (!outputs.some(file => file.path === "server.example.json")) {
        const config = { host: "127.0.0.1", port: 9001, allowedOrigins: "*", transports: ["polling", "websocket"], gateway: {
            routes: [{ host: "127.0.0.1", address: "203.0.113.20", names: ["game-server.example"], ports: [2302], protocols: ["udp", "tcp"] }],
            udpListeners: [{ id: "loopback-host", bindHost: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], maxOwners: 1, maxPeers: 64, idleTimeoutMs: 60000 }],
        } };
        await write("server.example.json", Buffer.from(JSON.stringify(config, null, 2) + "\n"), null, "generated-loopback-config-v1");
    }
    if (!outputs.some(file => file.path === ".gitignore"))
        await write(".gitignore", Buffer.from("target/\nnode_modules/\nnative-helper/build/\nlogs/\n"), null, "generated-ignore-v1");
    // Reject escaping Cargo path dependencies without invoking Cargo or reading
    // registry credentials. All runtime path dependencies must be in this tree.
    for (const file of outputs.filter(file => file.path.endsWith("Cargo.toml"))) {
        const text = await readFile(join(destination, file.path), "utf8");
        for (const match of text.matchAll(/\bpath\s*=\s*["']([^"'\r\n]+)["']/g)) {
            const target = resolve(destination, dirname(file.path), match[1]);
            if (!inside(destination, target)) throw new Error("Cargo path dependency escapes export: " + file.path + " -> " + match[1]);
        }
    }
    const after = await snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Selected source files changed during export");
    for (const output of outputs)
        if (digest(await readFile(join(destination, output.path))) !== output.sha256) throw new Error("Export verification failed: " + output.path);
    const manifest = {
        version: 1, created: new Date().toISOString(), sourceInventorySha256: digest(JSON.stringify(before)),
        sourceVerifiedAfterCopy: true, sourceFiles: before, files: outputs.sort((a, b) => a.path.localeCompare(b.path, "en")),
        excludedPaths: [...new Set(ignored)].sort(), helperSources: "canonical packages/lan/native", installedDependencies: false,
        compiledBinaries: false, gitOrPublicationPerformed: false,
    };
    await writeFile(join(destination, "EXPORT-MANIFEST.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    await writeFile(join(destination, "EXPORT-STATE.json"), JSON.stringify({ phase: "complete", sourceInventorySha256: manifest.sourceInventorySha256, files: outputs.length }, null, 2));
    console.log(JSON.stringify({ destination, files: outputs.length, sourceInventorySha256: manifest.sourceInventorySha256, sourceVerifiedAfterCopy: true }));
}

if (import.meta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
