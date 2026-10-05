#!/usr/bin/env bun
/**
 * Export a subtree of the RUNNING guest's filesystem to a local directory.
 *
 * The bridge between "the game generated it" and "the bundle ships it". A title that builds
 * content on first run — a shader cache, a detected-hardware config, a converted asset —
 * writes it into the CoW overlay, where it lives only in that browser profile. This pulls the
 * subtree out through the VFS (the guest's own view, so it works while the game is running and
 * regardless of whether the overlay has committed to OPFS yet) so it can be packed with
 * `bun tools/wgb.ts add-dir`.
 *
 * Usage:
 *   bun tools/guest-export.ts <guest-dir> <out-dir>
 *   BS_TAB=fc bun tools/guest-export.ts "Shaders/Cache" tmp/cache --overlay-only
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { harness } from "./harness";

const args = process.argv.slice(2).filter((a) => a !== "--overlay-only");
/** Export only what the GUEST wrote: the VFS reports which layer answered, and a merged
 *  listing otherwise hands back the whole read-only ROM tree alongside it. */
const overlayOnly = process.argv.includes("--overlay-only");
const [guestDir, outDir] = args;
if (!guestDir || !outDir) {
    console.error("Usage: bun tools/guest-export.ts <guest-dir> <out-dir>");
    process.exit(1);
}

interface Entry { name: string; path: string; kind: string; size: number; source?: string }

async function list(dir: string): Promise<Entry[]> {
    const r = await harness().call("fsList", dir).run() as { steps: Array<{ result?: Entry[] }> };
    return r.steps[0]?.result ?? [];
}

/** Collect files depth-first, keeping each one's path RELATIVE to the exported root. */
const files: Array<{ guestPath: string; rel: string }> = [];
async function walk(dir: string, rel: string): Promise<void> {
    for (const e of await list(dir)) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.kind === "dir" || e.kind === "directory") { await walk(`${dir}/${e.name}`, childRel); continue; }
        // Zero-length files are EXPORTED. An empty file is content: the HP Philosopher's Stone
        // demo's empty Detected.ini is load-bearing, and a missing one changes guest behaviour
        // exactly as a missing directory does (see make-wgb's empty-dir gotcha).
        if (e.size < 0) continue;
        if (overlayOnly && e.source !== "overlay") continue;
        files.push({ guestPath: `${dir}/${e.name}`, rel: childRel });
    }
}
await walk(guestDir.replace(/[\\/]+$/, ""), "");
if (files.length === 0) { console.error(`No files under ${guestDir}`); process.exit(1); }
console.log(`${files.length} file(s) to export`);

// One chain per batch: a single RPC carrying hundreds of base64 payloads overruns the eval
// budget, and a chain that dies takes every earlier read in it with it.
const BATCH = 25;
let written = 0;
for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    let chain = harness();
    for (const f of batch) chain = chain.call("fsRead", f.guestPath);
    const res = await chain.run() as { steps: Array<{ result?: { content?: string; encoding?: string } }> };
    batch.forEach((f, n) => {
        const r = res.steps[n]?.result;
        // `content: ""` is a zero-byte FILE; only a missing result is a failed read.
        if (r?.content === undefined) { console.warn(`  (read failed) ${f.guestPath}`); return; }
        const dest = join(outDir, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8"));
        written++;
    });
    console.log(`  ${Math.min(i + BATCH, files.length)}/${files.length}`);
}
console.log(`Exported ${written} file(s) from ${guestDir} -> ${outDir}`);
