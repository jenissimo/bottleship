/**
 * Build the codegen-pair demo: ONE C++ source, two toolchains.
 *   arm A: MSVC x86 /O2 /arch:IA32 -> PE -> BottleShip's x86 JIT/AOT -> Wasm
 *   arm B: Emscripten -O3 -> Wasm directly
 *
 * The kernels sit in their own named code sections, so each lands on its own page and a
 * captured JIT module maps to exactly one kernel (see codegen.h). The point of the pair is to
 * read OUR generated Wasm for a kernel against a good compiler's Wasm for the same source.
 *
 * Usage: node tools/bench-v86/source-pair/build-codegen.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const out = path.resolve(process.argv[2] || 'C:/Projects/bottleship-demos/demo_codegen_pair');
const sdk = path.resolve(process.env.EMSDK || 'C:/Projects/emsdk');
const vs = process.env.VSINSTALLDIR || 'C:/Program Files/Microsoft Visual Studio/2022/Community';
const kit = process.env.WindowsSdkDir || 'C:/Program Files (x86)/Windows Kits/10';
const newest = p => fs.readdirSync(p).filter(n => /^\d+\./.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const vc = path.join(vs, 'VC/Tools/MSVC', newest(path.join(vs, 'VC/Tools/MSVC')));
const kv = newest(path.join(kit, 'Include'));
const env = {
    ...process.env,
    INCLUDE: [path.join(vc, 'include'), ...['ucrt', 'shared', 'um'].map(n => path.join(kit, 'Include', kv, n))].join(';'),
    LIB: [path.join(vc, 'lib/x86'), ...['ucrt', 'um'].map(n => path.join(kit, 'Lib', kv, n, 'x86'))].join(';'),
    EM_CONFIG: path.join(sdk, '.emscripten'),
};
for (const n of ['out', 'rom', 'web', 'sources']) fs.mkdirSync(path.join(out, n), { recursive: true });

const history = [];
function run(exe, args, cwd = out, runEnv = env) {
    const r = spawnSync(exe, args, { cwd, env: runEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    history.push({ exe, args, exitCode: r.status, stdout: r.stdout, stderr: r.stderr });
    if (r.error || r.status !== 0) {
        fs.writeFileSync(path.join(out, 'build-failed.json'), JSON.stringify(history, null, 2));
        throw Error(`${exe}: ${r.error || r.stderr || r.stdout}`);
    }
    return r.stdout;
}
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const sources = fs.readdirSync(path.join(here, 'fixture-codegen'));
for (const name of sources) fs.copyFileSync(path.join(here, 'fixture-codegen', name), path.join(out, 'sources', name));

const cl = path.join(vc, 'bin/Hostx64/x86/cl.exe');
const common = ['/nologo', '/c', '/O2', '/Ob2', '/Oi', '/GS-', '/GR-', '/EHs-c-', '/GL-', '/arch:IA32', '/W4'];
for (const name of ['kernels', 'windows', 'msvcshim']) {
    run(cl, [...common,
        `/Fo${path.join(out, 'out', name + '.obj')}`, '/FAs', `/Fa${path.join(out, 'out', name + '.asm')}`,
        path.join(out, 'sources', name + '.cpp')]);
}
run(path.join(vc, 'bin/Hostx64/x86/link.exe'), ['/nologo', '/MACHINE:X86', '/SUBSYSTEM:CONSOLE', '/ENTRY:mainCRTStartup',
    '/NODEFAULTLIB', '/DYNAMICBASE:NO', '/FIXED', '/BASE:0x400000', '/OPT:REF', '/OPT:ICF',
    // Merging is what would defeat the per-kernel sections; keep every .cgk* section distinct.
    `/MAP:${path.join(out, 'out', 'codegen.map')}`, `/OUT:${path.join(out, 'rom', 'codegen.exe')}`,
    ...['kernels', 'windows', 'msvcshim'].map(n => path.join(out, 'out', n + '.obj')), 'kernel32.lib']);

const python = path.join(sdk, 'python', fs.readdirSync(path.join(sdk, 'python')).find(n => n.endsWith('_64bit')), 'python.exe');
const emcc = path.join(sdk, 'upstream/emscripten/em++.py');
run(python, [emcc, '--version']);
run(python, [emcc, ...['kernels', 'emscripten'].map(n => path.join(out, 'sources', n + '.cpp')),
    '-O3', '-g2', '-fno-exceptions', '-fno-rtti', '-fno-vectorize', '-fno-slp-vectorize',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node',
    // The kernels are exported so LLVM cannot inline them away: a like-for-like read against
    // our per-page modules needs the same function boundaries on both arms.
    '-sEXPORTED_FUNCTIONS=["_cg_init","_cg_run","_cg_state","_cg_size","_cg_k1_walk","_cg_k2_list","_cg_k3_stride","_cg_k4_indirect","_cg_k5_x87","_cg_k6_frame","_cg_checksum"]',
    '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU32","HEAPU8"]',
    '-o', path.join(out, 'web', 'codegen.mjs')]);

run(path.join(sdk, 'upstream/bin/wasm-dis.exe'), [path.join(out, 'web', 'codegen.wasm'), '-o', path.join(out, 'web', 'codegen.wat')]);
fs.writeFileSync(path.join(out, 'out', 'codegen.disasm.txt'),
    run(path.join(sdk, 'upstream/bin/llvm-objdump.exe'), ['-d', '--x86-asm-syntax=intel', path.join(out, 'rom', 'codegen.exe')]));
fs.writeFileSync(path.join(out, 'out', 'codegen.headers.txt'),
    run(path.join(sdk, 'upstream/bin/llvm-readobj.exe'), ['--file-headers', '--sections', '--coff-exports', path.join(out, 'rom', 'codegen.exe')]));

// Per-kernel page map: which VA range the JIT will publish a module for. Parsed from the PE
// section headers, because the whole attribution rests on one kernel per page.
const headers = fs.readFileSync(path.join(out, 'out', 'codegen.headers.txt'), 'utf8');
const sectionMap = {};
{
    const blocks = headers.split(/Section \{/).slice(1);
    for (const b of blocks) {
        const name = /Name:\s+(\S+)/.exec(b)?.[1];
        const va = /VirtualAddress:\s+(\S+)/.exec(b)?.[1];
        const size = /VirtualSize:\s+(\S+)/.exec(b)?.[1];
        if (!name || !va || !/^\.cgk/.test(name)) continue;
        const rva = Number(va);
        sectionMap[name] = { rva, va: 0x400000 + rva, virtualSize: Number(size), page: (0x400000 + rva) & ~0xfff };
    }
}
// The start gate's address: the driver writes it directly into guest memory, so it has to come
// from the linker map rather than from a guess.
const mapText = fs.readFileSync(path.join(out, 'out', 'codegen.map'), 'utf8');
const goMatch = /^\s*\S+\s+_cg_go\s+([0-9a-fA-F]{8})\s/m.exec(mapText);
if (!goMatch) throw Error('_cg_go not found in the linker map: the start gate would be unaddressable');
const goAddress = parseInt(goMatch[1], 16);

const pages = Object.values(sectionMap).map(s => s.page);
const collisions = pages.length !== new Set(pages).size;
if (!Object.keys(sectionMap).length) throw Error('No .cgk* sections in the PE: per-kernel attribution would be a page-level guess');
if (collisions) throw Error(`Two kernels share a page: ${JSON.stringify(sectionMap)}`);

fs.writeFileSync(path.join(out, 'rom', 'codegen-service.bin'), 'codegen pair service fixture\n');
// One bundle per kernel: the args differ only in which kernel runs, and a fixed bundle per
// kernel keeps the capture driver free of manifest-override machinery.
// Rounds calibrated per kernel from the native arm so every kernel's guest-timed phase is
// seconds rather than milliseconds: the walk kernels do ~30 ms of native work per round while
// the straight-line ones do ~0.03 ms, so one shared round count would leave half of them below
// the resolution of GetTickCount and make the other half take minutes.
const ROUNDS = { 1: 1, 2: 435, 3: 1000, 4: 588, 5: 690, 6: 1 };
// TWO work volumes per kernel. A single volume measures cold start plus the codegen gap:
// JIT_THRESHOLD is 200k retired instructions (jit.rs:1870), compilation is async, and V8 still
// tiers Liftoff->TurboFan inside a 100-700 ms phase. The slope (t2-t1)/(n2-n1) subtracts every
// fixed cost that does not scale with the work, which is what "the codegen gap" means.
const VOLUMES = { lo: 1, hi: 4 };
const bundles = [];
for (const [tag, mult] of Object.entries(VOLUMES)) for (let k = 1; k <= 6; k++) {
    const file = path.join(out, `codegen-k${k}-${tag}.wgb`);
    run(process.env.BUN_EXE || 'bun', ['tools/make-wgb.ts', path.join(out, 'rom'), file,
        '--name', `Codegen Pair Lab k${k} ${tag}`, '--exe', 'codegen.exe', '--ram', '128', '--os', 'winnt',
        // Fixed work sized so the guest-timed phase is seconds, not milliseconds: at 4096x8
        // the phase was 11 ms, which is at the resolution of GetTickCount itself.
        // controlled=1: the guest waits for C:\codegen-go.bin before the timed phase, so the
        // driver can configure a runtime JIT switch (which clears the JIT cache) BEFORE the
        // kernel's page is ever compiled. Without the gate the kernel is already hot.
        '--args', `73 ${k} 4096 ${ROUNDS[k] * mult} 1`], repo);
    bundles.push(`codegen-k${k}-${tag}.wgb`);
}

// The sidecar's root set does not include the demos tree, and Vite serves public/ directly:
// publish the bundle where a plain harness openWgb can reach it by URL.
const published = path.join(repo, 'public/apps/codegen-pair');
fs.mkdirSync(published, { recursive: true });
for (const b of bundles) fs.copyFileSync(path.join(out, b), path.join(published, b));

const artifacts = ['rom/codegen.exe', ...bundles, 'web/codegen.mjs', 'web/codegen.wasm', 'web/codegen.wat',
    'out/codegen.map', 'out/codegen.disasm.txt', 'out/codegen.headers.txt'];
const manifest = {
    schema: 1, builtAt: new Date().toISOString(), repo, out, emsdk: sdk, msvc: vc, windowsSdk: kv,
    host: { hostname: os.hostname(), release: os.release(), arch: os.arch() },
    policy: {
        pe: 'MSVC /O2 /arch:IA32, no CRT, no LTO; one kernel per named code section',
        direct: 'Emscripten -O3 scalar, no LTO',
        note: 'Same kernels source. Section placement is what makes a captured JIT module attributable to one kernel.',
    },
    sectionMap, goAddress, volumes: VOLUMES, rounds: ROUNDS, count: 4096,
    sources: Object.fromEntries(sources.map(n => [n, hash(path.join(out, 'sources', n))])),
    artifacts: Object.fromEntries(artifacts.map(n => [n, { sha256: hash(path.join(out, n)), bytes: fs.statSync(path.join(out, n)).size }])),
    history,
};
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ out, goAddress: '0x'+goAddress.toString(16), sectionMap, bundles, pe: manifest.artifacts['rom/codegen.exe'], wasm: manifest.artifacts['web/codegen.wasm'] }, null, 2));
