#!/usr/bin/env node
// Headless BYTEmark (nbench) runner for v86 engines — stock upstream or the
// BottleShip fork — using upstream's own tests/benchmark/arch-bytemark.js recipe:
// resume the Arch Linux state image, run ~/nbench over serial, parse the scores.
//
// Usage:
//   node run-bytemark.mjs --engine <v86-root> [--label name] [options]
//
//   --engine <dir>    v86 root containing build/libv86.mjs + build/v86.wasm
//   --bios <dir>      BIOS dir (default: <engine>/bios, fallback: vendor/v86/bios)
//   --images <dir>    images cache (default: tools/bench-v86/images)
//   --boot fs|state   fs = fresh kernel boot from 9p (default; guest TSC self-
//                     calibrates against the engine → comparable guest-timed scores).
//                     state = resume arch_state (fast, but the state's tsc_khz was
//                     calibrated on the SAVING engine — only valid if rates match).
//   --state <file>    state image for --boot state (default: <images>/arch_state-v2.bin.zst)
//   --flags "i=v,..." set_jit_config pairs applied at start (fork only)
//   --relaxed 0|1     set_relaxed_fpu (fork only; default: leave engine default)
//   --tests A,B       run only these nbench tests (DO* names); default: full suite
//   --label <name>    config label for the result JSON
//   --out <file>      result JSON path (default: results/<label>-<epoch>.json)
//   --timeout <min>   abort after N minutes (default 90)
//   --verbose         log serial output + mirror downloads
//
// First run needs network (lazy-mirrors 9p chunks from i.copy.sh); later runs are offline.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { installLazyMirror } from "./fs-lazy-mirror.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// ── args ────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
    else args[key] = "1";
}

const ALL_TESTS = ["DONUMSORT", "DOSTRINGSORT", "DOBITFIELD", "DOEMF", "DOFOUR",
    "DOASSIGN", "DOIDEA", "DOHUFF", "DONNET", "DOLU"];

if (!args.engine) {
    console.error("--engine <v86-root> is required");
    process.exit(2);
}
const engineRoot = path.resolve(args.engine);
const libv86Path = path.join(engineRoot, "build", "libv86.mjs");
const wasmPath = path.join(engineRoot, "build", "v86.wasm");
if (!fs.existsSync(libv86Path) || !fs.existsSync(wasmPath)) {
    console.error(`engine build not found: ${libv86Path} / ${wasmPath}`);
    process.exit(2);
}
let biosDir = args.bios ? path.resolve(args.bios) : path.join(engineRoot, "bios");
if (!fs.existsSync(path.join(biosDir, "seabios.bin"))) {
    biosDir = path.resolve(__dirname, "../../vendor/v86/bios");
}
const imagesDir = path.resolve(args.images || path.join(__dirname, "images"));
const bootMode = args.boot || "fs";
const statePath = path.resolve(args.state || path.join(imagesDir, "arch_state-v2.bin.zst"));
const fsJsonPath = path.join(imagesDir, "fs.json");
if (bootMode === "state" && !fs.existsSync(statePath)) {
    console.error(`state image missing: ${statePath}\nrun: node tools/bench-v86/fetch-images.mjs`);
    process.exit(2);
}
if (bootMode === "fs" && !fs.existsSync(fsJsonPath)) {
    console.error(`fs.json missing: ${fsJsonPath}\nrun: node tools/bench-v86/fetch-images.mjs`);
    process.exit(2);
}
const label = args.label || path.basename(engineRoot);
const timeoutMs = (Number(args.timeout) || 90) * 60_000;
const verbose = !!args.verbose;
const selectedTests = args.tests ? args.tests.split(",").map(s => s.trim().toUpperCase()) : null;
if (selectedTests) {
    for (const t of selectedTests) {
        if (!ALL_TESTS.includes(t)) { console.error(`unknown test ${t}; valid: ${ALL_TESTS.join(",")}`); process.exit(2); }
    }
}
const flagPairs = (args.flags || "").split(",").filter(Boolean).map(s => {
    const [i, v] = s.split("=");
    return [Number(i), Number(v)];
});

// ── lazy 9p mirror ──────────────────────────────────────────────────────────
const mirrorStats = installLazyMirror({
    mirrorRoot: path.join(imagesDir, "arch"),
    cdnBase: "https://i.copy.sh/arch/",
    verbose,
});

// ── boot ────────────────────────────────────────────────────────────────────
const { V86 } = await import(url.pathToFileURL(libv86Path).href);

const baseConfig = {
    bios: { url: path.join(biosDir, "seabios.bin") },
    vga_bios: { url: path.join(biosDir, "vgabios.bin") },
    wasm_path: wasmPath,
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    net_device: { type: "virtio", relay_url: "<UNUSED>" },
    log_level: 0,
};
const emulator = new V86(bootMode === "state"
    ? {
        ...baseConfig,
        initial_state: { url: statePath },
        filesystem: { baseurl: path.join(imagesDir, "arch") + path.sep },
    }
    : {
        ...baseConfig,
        bzimage_initrd_from_filesystem: true,
        cmdline: "rw console=ttyS0 apm=off root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off audit=0 tsc=reliable nowatchdog init=/usr/bin/init-openrc",
        filesystem: {
            basefs: { url: fsJsonPath },
            baseurl: path.join(imagesDir, "arch") + path.sep,
        },
    });

const result = {
    label,
    engine: engineRoot,
    flags: Object.fromEntries(flagPairs),
    relaxed: args.relaxed !== undefined ? Number(args.relaxed) : null,
    tests_selected: selectedTests || "all",
    node: process.version,
    started_at: new Date().toISOString(),
    clock: null,          // guest-vs-host skew check
    scores: {},           // per-test iterations/sec (guest-clock based)
    int_index: null,
    fp_index: null,
    memory_index: null,
    wall_ms: null,        // host wall-clock, command sent → trademark line
    test_wall_ms: {},     // host timestamps as each score line arrives
    mirror: mirrorStats,
};

let serialText = "";
let line = "";
let benchStart = 0;
let lastLineAt = 0;
let phase = "boot"; // boot → clocksource → clock1 → clock2 → bench → done
const clockMarks = [];
let clockHostMarks = [];

const watchdog = setTimeout(() => {
    console.error(`\n[bench] TIMEOUT after ${timeoutMs / 60000} min (phase=${phase})`);
    console.error(serialText.slice(-2000));
    process.exit(3);
}, timeoutMs);

function applyEngineConfig() {
    const exports = emulator?.v86?.cpu?.wm?.exports;
    if (args.relaxed !== undefined) {
        if (!exports?.set_relaxed_fpu) { console.error("--relaxed requested but set_relaxed_fpu export missing (stock engine?)"); process.exit(2); }
        exports.set_relaxed_fpu(Number(args.relaxed));
    }
    if (flagPairs.length) {
        if (!exports?.set_jit_config) { console.error("--flags requested but set_jit_config export missing (stock engine?)"); process.exit(2); }
        for (const [i, v] of flagPairs) exports.set_jit_config(i, v);
        const readback = flagPairs.map(([i]) => `${i}=${exports.get_jit_config ? exports.get_jit_config(i) : "?"}`).join(",");
        console.error(`[bench] jit flags applied: ${readback}`);
    }
    if (exports?.get_relaxed_fpu) console.error(`[bench] relaxed_fpu=${exports.get_relaxed_fpu()}`);
}

function sendClockProbe() {
    clockHostMarks.push(Date.now());
    emulator.serial0_send("echo CLKMARK:$(date +%s%3N)\n");
}

function startBench() {
    phase = "bench";
    const excluded = selectedTests ? ALL_TESTS.filter(n => !selectedTests.includes(n)) : [];
    const set = excluded.map(n => `echo ${n}=0 >> CMD`).join(" && ");
    benchStart = Date.now();
    emulator.serial0_send(
        `echo 0 > /sys/class/graphics/fbcon/cursor_blink && cd nbench && touch CMD && ${set || "echo"} && ./nbench -cCMD\n`);
}

function beginProbes() {
    phase = "clocksource";
    emulator.serial0_send(
        "echo CSRC:$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource)\n");
}

emulator.bus.register("emulator-started", () => {
    console.error(`[bench] engine started: ${label} (boot=${bootMode})`);
    applyEngineConfig(); // before guest code compiles — consistent codegen for the whole run
    if (bootMode === "state") setTimeout(beginProbes, 1000);
    // fs mode: wait for the login prompt (detected in the serial listener)
});

// Serial lines may carry terminal escape remnants (e.g. "[?2004l" bracketed-paste
// with the ESC byte filtered out) — never anchor at line start.
const SCORE_RE = /(NUMERIC SORT|STRING SORT|BITFIELD|FP EMULATION|FOURIER|ASSIGNMENT|IDEA|HUFFMAN|NEURAL NET|LU DECOMPOSITION)\s*:\s*([\d.eE+]+)\s*:/;

function onLine(l) {
    lastLineAt = Date.now();
    if (verbose) console.error(`  | ${l}`);

    const csrc = l.match(/CSRC:(\w+)/);
    if (csrc && phase === "clocksource") {
        result.clocksource = csrc[1];
        console.error(`[bench] guest clocksource: ${csrc[1]}`);
        phase = "clock1";
        setTimeout(sendClockProbe, 500);
        return;
    }

    const clk = l.match(/CLKMARK:(\d+)/);
    if (clk && (phase === "clock1" || phase === "clock2")) {
        clockMarks.push(Number(clk[1]));
        if (phase === "clock1") {
            phase = "clock2";
            setTimeout(sendClockProbe, 4000); // 4s host gap; compare guest delta
        } else {
            const guestDelta = clockMarks[1] - clockMarks[0];
            const hostDelta = clockHostMarks[1] - clockHostMarks[0];
            result.clock = { guest_ms: guestDelta, host_ms: hostDelta, ratio: guestDelta / hostDelta };
            const skew = Math.abs(1 - result.clock.ratio);
            console.error(`[bench] clock check: guest ${guestDelta}ms / host ${hostDelta}ms (ratio ${result.clock.ratio.toFixed(4)})`);
            if (skew > 0.03) console.error(`[bench] WARNING: guest clock skew ${(skew * 100).toFixed(1)}% — guest-timed scores are NOT trustworthy`);
            startBench();
        }
        return;
    }

    const m = l.match(SCORE_RE);
    if (m && phase === "bench") {
        result.scores[m[1]] = Number(m[2]);
        result.test_wall_ms[m[1]] = Date.now() - benchStart;
        console.error(`[bench] ${m[1]}: ${m[2]} iter/s  (+${((Date.now() - benchStart) / 1000).toFixed(0)}s)`);
        return;
    }
    let idx = l.match(/INTEGER INDEX\s*:\s*([\d.]+)/);
    if (idx) { result.int_index = Number(idx[1]); return; }
    idx = l.match(/FLOATING-POINT INDEX\s*:\s*([\d.]+)/);
    if (idx) { result.fp_index = Number(idx[1]); return; }
    idx = l.match(/MEMORY INDEX\s*:\s*([\d.]+)/);
    if (idx) { result.memory_index = Number(idx[1]); return; }

    if (l.includes("* Trademarks are property of their respective holder.")) {
        finish();
    }
}

function finish() {
    clearTimeout(watchdog);
    result.wall_ms = Date.now() - benchStart;
    result.finished_at = new Date().toISOString();
    emulator.destroy();

    const outPath = path.resolve(args.out ||
        path.join(__dirname, "results", `${label}-${Date.now()}.json`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

    console.error(`\n[bench] done in ${(result.wall_ms / 1000).toFixed(0)}s — ${outPath}`);
    console.log(JSON.stringify(result));
    process.exit(0);
}

emulator.add_listener("serial0-output-byte", (byte) => {
    const chr = String.fromCharCode(byte);
    if (chr < " " && chr !== "\n" && chr !== "\t" || chr > "~") return;
    serialText += chr;
    if (chr === "\n") { const l = line; line = ""; onLine(l); }
    else {
        line += chr;
        // fs boot: fire on the first root prompt (may carry color-escape remnants)
        if (phase === "boot" && bootMode === "fs" && chr === " " &&
            /root@localhost[^\n]*# $/.test(line)) {
            console.error(`[bench] boot prompt after ${((Date.now() - bootT0) / 1000).toFixed(0)}s`);
            beginProbes();
        }
    }
});
const bootT0 = Date.now();
