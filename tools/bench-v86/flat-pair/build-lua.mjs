// Build the Lua 5.4 workload into out/lua/ with the same arms as build.mjs:
//   flat.exe   MSVC x86 /O2 /arch:IA32 freestanding PE (+ src-lua mini libc), for run-v86.mjs
//   flat.mjs   Emscripten -O3 -fno-vectorize -fno-slp-vectorize, same mini libc, for run-em.mjs
// Prerequisite: the official tarball unpacked in third_party/lua/ (see README).
//   node build-lua.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, cl, link, clang, python, run, hash, MSVC, CLANG, vc, sdk, kv } from "./build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LUA_VERSION = "5.4.9";
const LUA_SHA256 = "2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6"; // lua.org/ftp listing
const tarball = path.join(here, "third_party/lua", `lua-${LUA_VERSION}.tar.gz`);
const luaSrc = path.join(here, "third_party/lua", `lua-${LUA_VERSION}`, "src");
if (!fs.existsSync(luaSrc)) {
    console.error(`missing ${luaSrc}: download https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz into third_party/lua/ and unpack it (see README)`);
    process.exit(2);
}
if (fs.existsSync(tarball) && hash(tarball) !== LUA_SHA256) { console.error(`tarball sha256 mismatch: ${hash(tarball)}`); process.exit(2); }

const out = path.join(here, "out", process.argv[2] || "lua");
for (const d of ["obj", "objl", "objn"]) fs.mkdirSync(path.join(out, d), { recursive: true });
const history = [];
const O = (f) => path.join(out, f);
const S = (f) => path.join(here, "src", f);
const SL = (f) => path.join(here, "src-lua", f);

// Embed bench.lua as a C string.
const script = fs.readFileSync(SL("bench.lua"), "utf8").replace(/\r\n/g, "\n");
const lit = script.split("\n").map((l) => '"' + l.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '\\n"').join("\n");
fs.writeFileSync(O("lua_script.h"), `/* generated from src-lua/bench.lua */\nstatic const char BS_LUA_SCRIPT[] =\n${lit};\n`);

const CORE = ["lapi", "lcode", "lctype", "ldebug", "ldo", "ldump", "lfunc", "lgc", "llex", "lmem", "lobject", "lopcodes",
    "lparser", "lstate", "lstring", "ltable", "ltm", "lundump", "lvm", "lzio", "lauxlib", "lbaselib", "lstrlib", "ltablib", "lmathlib"];
const cFiles = [...CORE.map((n) => path.join(luaSrc, n + ".c")), SL("minilibc.c"), SL("lua_wl.c")];
const incs = [SL("include"), luaSrc, path.join(here, "src"), out];

// arm A: MSVC. /Oi- (no intrinsics) and /X (no system headers): every libc call goes to the
// mini libc, exactly as in the Wasm arm (built with -fno-builtin).
const MSVC_LUA = MSVC.filter((f) => f !== "/Oi").concat(["/Oi-", "/X", "/TC", "/W0", `/FI${SL("bs_luacfg.h")}`, ...incs.map((i) => `/I${i}`)]);
run(history, cl, [...MSVC_LUA, `/Fo${path.join(out, "obj")}\\`, ...cFiles], out);
run(history, cl, [...MSVC, "/X", `/I${path.join(here, "src")}`, `/Fo${O("obj/driver.obj")}`, S("driver.cpp")], out);
run(history, cl, [...MSVC, "/X", "/DBS_HAVE_LIBC", `/I${path.join(here, "src")}`, `/Fo${O("obj/plat_v86.obj")}`, S("plat_v86.cpp")], out);
run(history, cl, [...MSVC, "/X", `/I${path.join(here, "src")}`, `/Fo${O("objn/plat_native_lua.obj")}`, SL("plat_native_lua.cpp")], out);
const list = (d, skip) => fs.readdirSync(path.join(out, d)).filter((f) => f.endsWith(".obj") && f !== skip).map((f) => path.join(out, d, f));
const objs = list("obj");
const freeLink = ["/nologo", "/MACHINE:X86", "/SUBSYSTEM:CONSOLE", "/ENTRY:bs_entry", "/NODEFAULTLIB", "/DYNAMICBASE:NO",
    "/FIXED", "/BASE:0x400000", "/OPT:REF", "/OPT:NOICF", "/INCREMENTAL:NO"];
run(history, link, [...freeLink, `/MAP:${O("flat.map")}`, `/OUT:${O("flat.exe")}`, ...objs], out);
// arm C: the same MSVC objects natively, CRT-free (kernel32 for the clock and stdout only).
const nativeLink = ["/nologo", "/MACHINE:X86", "/SUBSYSTEM:CONSOLE", "/ENTRY:bs_native_entry", "/NODEFAULTLIB", "/OPT:REF", "/INCREMENTAL:NO", "kernel32.lib"];
run(history, link, [...nativeLink, `/OUT:${O("flat-native.exe")}`, ...list("obj", "plat_v86.obj"), O("objn/plat_native_lua.obj")], out);

// arms A'/C': clang i686 objects of the same sources (x87 only, no builtins, mini libc headers).
const CLANG_LUA = [...CLANG, "-nostdinc", "-w", ...incs.map((i) => `-I${i}`)];
for (const f of cFiles) run(history, clang, [...CLANG_LUA, "-x", "c", "-include", SL("bs_luacfg.h"), "-o", path.join(out, "objl", path.basename(f, ".c") + ".obj"), f], out);
run(history, clang, [...CLANG_LUA, "-o", path.join(out, "objl", "driver.obj"), S("driver.cpp")], out);
run(history, link, [...freeLink, `/MAP:${O("flat-llvm.map")}`, `/OUT:${O("flat-llvm.exe")}`, ...list("objl"), O("obj/plat_v86.obj")], out);
run(history, link, [...nativeLink, `/OUT:${O("flat-llvm-native.exe")}`, ...list("objl"), O("objn/plat_native_lua.obj")], out);

// arm B: Emscripten, same sources, same mini libc headers.
const emcc = path.join(sdk, "upstream/emscripten/emcc.py");
const EM_LUA = ["-O3", "-fno-vectorize", "-fno-slp-vectorize", "-fno-builtin", "-nostdinc", "-fno-exceptions", "-fno-rtti",
    "-w", ...incs.map((i) => `-I${i}`)];
run(history, python, [emcc, ...EM_LUA, "-include", SL("bs_luacfg.h"), ...cFiles.map((f) => f), S("driver.cpp"), S("plat_em.cpp"),
    "--js-library", S("plat_em.js"), "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=node", "-sINITIAL_MEMORY=67108864",
    '-sEXPORTED_FUNCTIONS=["_bs_main"]', "-sSTACK_SIZE=1048576", "-o", O("flat.mjs")], out);

const versions = {
    cl: run(history, cl, [], out).split(/\r?\n/)[0],
    emcc: run(history, python, [emcc, "--version"], out).split(/\r?\n/)[0],
    node: process.version,
};
const arts = ["flat.exe", "flat.wasm", "flat.mjs", "lua_script.h", "flat-native.exe", "flat-llvm.exe", "flat-llvm-native.exe"];
const manifest = {
    name: "lua", builtAt: new Date().toISOString(), lua: { version: LUA_VERSION, sha256: LUA_SHA256, source: `https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz`, license: "MIT" },
    params: { workload: "lua", script: "src-lua/bench.lua" }, meta: { files: CORE.length },
    versions, msvc: vc, emsdk: sdk, windowsSdk: kv, flags: { msvc: MSVC_LUA, emscripten: EM_LUA, clang: CLANG_LUA },
    artifacts: Object.fromEntries(arts.map((a) => [a, { sha256: hash(O(a)), bytes: fs.statSync(O(a)).size }])),
    history,
};
fs.writeFileSync(O("build.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ exe: manifest.artifacts["flat.exe"], wasm: manifest.artifacts["flat.wasm"] }));
