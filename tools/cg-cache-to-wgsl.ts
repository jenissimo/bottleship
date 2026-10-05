#!/usr/bin/env bun
/**
 * CryEngine shader-cache entry → WGSL, offline.
 *
 * A `.cgvp`/`.cgps`/`.cgasm` in `Shaders/Cache/` is the D3D assembly LISTING the engine
 * caches (fxc `/Fc`, or cgc for the ps_1_x profiles) and assembles at load time. That makes
 * every shader a game ever compiled reproducible without the game: assemble the listing with
 * the d3dx9 oracle, run it through OUR recompiler, and read the WGSL. Use it to ask "does
 * this shader translate, and to what" for a title's real shaders rather than for fixtures.
 *
 * Usage: bun tools/cg-cache-to-wgsl.ts <vs.cgvp> [ps.cgps] [--wgsl] [--validate]
 */

import { readFileSync } from "fs";
import { asmFixture } from "./tests/helpers/asm-fixture";
import {
    compileVertexShader, compilePixelShader, linkProgram,
} from "../src/worker/backends/webgpu/d3d9/shader";

/** The cache file carries a `//CGVER<n>` marker ahead of the listing; d3dx9 chokes on it. */
function listingOf(path: string): string {
    return readFileSync(path, "latin1").split(/\r?\n/).filter(l => !/^\/\/CGVER/.test(l)).join("\n");
}

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith("--"));
const wantWgsl = args.includes("--wgsl");
const wantValidate = args.includes("--validate");
if (files.length === 0) {
    console.error("usage: bun tools/cg-cache-to-wgsl.ts <vs.cgvp> [ps.cgps] [--wgsl] [--validate]");
    process.exit(2);
}

const vsPath = files.find(f => /\.(cgvp)$/i.test(f)) ?? null;
const psPath = files.find(f => /\.(cgps|cgasm)$/i.test(f)) ?? null;

const vsTokens = vsPath ? (await asmFixture(listingOf(vsPath))).tokens : null;
const psTokens = psPath ? (await asmFixture(listingOf(psPath))).tokens : null;
if (!vsTokens) { console.error("a vertex shader (.cgvp) is required to link"); process.exit(2); }

const linked = linkProgram({
    vs: compileVertexShader(vsTokens),
    ps: psTokens ? compilePixelShader(psTokens) : null,
    declElements: null,
    streamStride: 0,
});

console.log(`vs=${vsPath ?? "-"}\nps=${psPath ?? "-"}\nwgsl=${linked.wgsl.length} chars`);
if (wantValidate) {
    const { probeOfflineWgslValidator, validateWgslOffline } = await import("./d3d9-parity/wgsl-validator");
    const cap = probeOfflineWgslValidator();
    if (!cap.available) console.log("validator: UNAVAILABLE (naga not found) — nothing was checked");
    else {
        const r = validateWgslOffline(linked.wgsl, cap);
        console.log(`validator: ${r.status}${r.diagnostics ? `\n${r.diagnostics}` : ""}`);
    }
}
if (wantWgsl) console.log("\n" + linked.wgsl);
