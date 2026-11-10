// Build every arm of the flat pair for one or more workloads.
//
//   node build.mjs [preset|name=<json> ...]      default: tight medium flat
//
// For each workload W into out/W/:
//   workload.cpp           generated source (gen.mjs), + workload.meta.json
//   flat.exe               arm A:  MSVC x86 /O2 /arch:IA32, freestanding PE (run under v86 by run-v86.mjs)
//   flat.mjs/.wasm         arm B:  Emscripten -O3 -fno-vectorize -fno-slp-vectorize (run by run-em.mjs)
//   flat-native.exe        arm C:  the SAME MSVC objects linked with a CRT/QPC platform, native host
//   flat-llvm.exe          arm A': clang i686 -O3 -mno-sse objects in the freestanding PE (v86)
//   flat-llvm-native.exe   arm C': the clang objects natively (MSVC-vs-LLVM calibration)
//   build.json             tools, versions, commands, hashes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveParams, generate } from "./gen.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(process.env.EMSDK || "C:/Projects/emsdk");
const vs = process.env.VSINSTALLDIR || "C:/Program Files/Microsoft Visual Studio/2022/Community";
const kit = process.env.WindowsSdkDir || "C:/Program Files (x86)/Windows Kits/10";
const newest = (p) => fs.readdirSync(p).filter((n) => /^\d+\./.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const vc = path.join(vs, "VC/Tools/MSVC", newest(path.join(vs, "VC/Tools/MSVC")));
const kv = newest(path.join(kit, "Include"));
const env = {
    ...process.env,
    INCLUDE: [path.join(vc, "include"), ...["ucrt", "shared", "um"].map((n) => path.join(kit, "Include", kv, n))].join(";"),
    LIB: [path.join(vc, "lib/x86"), ...["ucrt", "um"].map((n) => path.join(kit, "Lib", kv, n, "x86"))].join(";"),
    EM_CONFIG: path.join(sdk, ".emscripten"),
};
const cl = path.join(vc, "bin/Hostx64/x86/cl.exe");
const link = path.join(vc, "bin/Hostx64/x86/link.exe");
const clang = path.join(sdk, "upstream/bin/clang.exe");
const python = path.join(sdk, "python", fs.readdirSync(path.join(sdk, "python")).find((n) => n.endsWith("_64bit")), "python.exe");
const empp = path.join(sdk, "upstream/emscripten/em++.py");
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function run(history, exe, args, cwd) {
    const r = spawnSync(exe, args, { cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    history.push({ exe, args, exitCode: r.status, stdout: (r.stdout || "").slice(0, 4000), stderr: (r.stderr || "").slice(0, 4000) });
    if (r.error || r.status !== 0) {
        throw Error(`${path.basename(exe)} failed (${r.status}): ${r.error || ""}\n${(r.stdout || "").slice(-3000)}\n${(r.stderr || "").slice(-3000)}`);
    }
    return (r.stdout || "") + (r.stderr || "");
}

// Same flags as source-pair/build-codegen.mjs, plus /Zc:threadSafeInit- (no CRT guard helpers).
const MSVC = ["/nologo", "/c", "/O2", "/Ob2", "/Oi", "/GS-", "/GR-", "/EHs-c-", "/GL-", "/arch:IA32", "/W3", "/Zc:threadSafeInit-", "/Gy"];
const CLANG = ["--target=i686-pc-windows-msvc", "-c", "-O3", "-fno-vectorize", "-fno-slp-vectorize", "-mno-sse", "-fno-exceptions",
    "-fno-rtti", "-fno-stack-protector", "-fno-builtin", "-ffunction-sections", "-Wno-everything"];
const EM = ["-O3", "-fno-vectorize", "-fno-slp-vectorize", "-fno-exceptions", "-fno-rtti"];

export { env, cl, link, clang, python, empp, run, hash, MSVC, CLANG, EM, vc, sdk, kv };

export function buildOne(name, spec) {
    const out = path.join(here, "out", name);
    fs.mkdirSync(out, { recursive: true });
    const history = [];
    const p = resolveParams(spec);
    const { src, meta } = generate(p);
    fs.writeFileSync(path.join(out, "workload.cpp"), src);
    fs.writeFileSync(path.join(out, "workload.meta.json"), JSON.stringify(meta, null, 2));
    const S = (f) => path.join(here, "src", f);
    const O = (f) => path.join(out, f);
    const inc = `/I${path.join(here, "src")}`;

    // arm A objects (MSVC)
    for (const [srcFile, obj] of [[O("workload.cpp"), "workload.obj"], [S("driver.cpp"), "driver.obj"], [S("plat_v86.cpp"), "plat_v86.obj"], [S("plat_native.cpp"), "plat_native.obj"]]) {
        run(history, cl, [...MSVC, inc, `/Fo${O(obj)}`, srcFile], out);
    }
    const linkFree = ["/nologo", "/MACHINE:X86", "/SUBSYSTEM:CONSOLE", "/ENTRY:bs_entry", "/NODEFAULTLIB", "/DYNAMICBASE:NO",
        "/FIXED", "/BASE:0x400000", "/OPT:REF", "/OPT:NOICF", "/INCREMENTAL:NO"];
    // Placement is OURS, not the compiler's: MSVC emits functions in its own internal order
    // (measured: unrelated to source order), so every function is a COMDAT (/Gy) and the linker
    // lays them out in the generator's emitOrder via /ORDER. A first link only harvests the
    // decorated names from its map.
    run(history, link, [...linkFree, `/MAP:${O("flat.map")}`, `/OUT:${O("flat.exe")}`, O("workload.obj"), O("driver.obj"), O("plat_v86.obj")], out);
    const mapText = fs.readFileSync(O("flat.map"), "utf8");
    const decorated = new Map();
    for (const m of mapText.matchAll(/(\?f(\d+)@@\S+|\?m@(V\d+_\d+)@@\S+)/g)) decorated.set(m[2] !== undefined ? `f${m[2]}` : m[3], m[1]);
    const orderList = meta.emitOrder.map((n) => decorated.get(n)).filter(Boolean);
    // Functions with no static caller (and, transitively, their only callees) are dropped by
    // /OPT:REF; the generator keeps that to a few percent. More than that is a generator bug.
    if (orderList.length < meta.emitOrder.length * 0.95) throw Error(`order file: ${orderList.length}/${meta.emitOrder.length} symbols resolved`);
    meta.linkedFunctions = orderList.length;
    fs.writeFileSync(O("order.txt"), orderList.join("\r\n") + "\r\n");
    linkFree.push(`/ORDER:@${O("order.txt")}`, "/IGNORE:4037");
    run(history, link, [...linkFree, `/MAP:${O("flat.map")}`, `/OUT:${O("flat.exe")}`, O("workload.obj"), O("driver.obj"), O("plat_v86.obj")], out);
    run(history, link, ["/nologo", "/MACHINE:X86", "/SUBSYSTEM:CONSOLE", "/OPT:REF", "/INCREMENTAL:NO", `/ORDER:@${O("order.txt")}`, "/IGNORE:4037", `/OUT:${O("flat-native.exe")}`,
        O("workload.obj"), O("driver.obj"), O("plat_native.obj")], out);

    // arm A'/C' objects (LLVM i686, x87 only like /arch:IA32)
    run(history, clang, [...CLANG, `-I${path.join(here, "src")}`, "-o", O("workload.llvm.obj"), O("workload.cpp")], out);
    run(history, clang, [...CLANG, `-I${path.join(here, "src")}`, "-o", O("driver.llvm.obj"), S("driver.cpp")], out);
    run(history, link, [...linkFree, `/MAP:${O("flat-llvm.map")}`, `/OUT:${O("flat-llvm.exe")}`, O("workload.llvm.obj"), O("driver.llvm.obj"), O("plat_v86.obj")], out);
    run(history, link, ["/nologo", "/MACHINE:X86", "/SUBSYSTEM:CONSOLE", "/OPT:REF", "/INCREMENTAL:NO", `/ORDER:@${O("order.txt")}`, "/IGNORE:4037", `/OUT:${O("flat-llvm-native.exe")}`,
        O("workload.llvm.obj"), O("driver.llvm.obj"), O("plat_native.obj")], out);

    // arm B (Emscripten)
    run(history, python, [empp, ...EM, `-I${path.join(here, "src")}`, O("workload.cpp"), S("driver.cpp"), S("plat_em.cpp"),
        "--js-library", S("plat_em.js"), "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=node",
        '-sEXPORTED_FUNCTIONS=["_bs_main"]', "-sSTACK_SIZE=1048576", "-o", O("flat.mjs")], out);

    const versions = {
        cl: run(history, cl, [], out).split(/\r?\n/)[0],
        emcc: run(history, python, [empp, "--version"], out).split(/\r?\n/)[0],
        clang: run(history, clang, ["--version"], out).split(/\r?\n/)[0],
        node: process.version,
    };
    const arts = ["workload.cpp", "flat.exe", "flat.wasm", "flat.mjs", "flat-native.exe", "flat-llvm.exe", "flat-llvm-native.exe"];
    const manifest = {
        name, builtAt: new Date().toISOString(), params: p, meta, versions, msvc: vc, emsdk: sdk, windowsSdk: kv,
        flags: { msvc: MSVC, clang: CLANG, emscripten: EM },
        artifacts: Object.fromEntries(arts.map((a) => [a, { sha256: hash(O(a)), bytes: fs.statSync(O(a)).size }])),
        history,
    };
    fs.writeFileSync(O("build.json"), JSON.stringify(manifest, null, 2));
    return { name, meta, artifacts: manifest.artifacts, versions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const specs = process.argv.slice(2);
    const list = specs.length ? specs : ["tight", "medium", "flat"];
    for (const s of list) {
        const eq = s.indexOf("=");
        const [name, spec] = eq > 0 ? [s.slice(0, eq), s.slice(eq + 1)] : [s, s];
        const r = buildOne(name, spec);
        console.log(JSON.stringify({ name: r.name, functions: r.meta.functions, exe: r.artifacts["flat.exe"].bytes, wasm: r.artifacts["flat.wasm"].bytes }));
    }
}
