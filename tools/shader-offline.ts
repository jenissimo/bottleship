#!/usr/bin/env bun
/**
 * Run OUR shader front end over real blobs, outside the emulator.
 *
 * Diagnosing "this shader will not create" inside a running guest costs a full boot per
 * hypothesis, and the answer arrives as one log line. Here the same bytes go through the same
 * parser in a process that starts in a second, so a parse failure can be stepped through — and
 * cross-checked against the shipped d3dx9 disassembler, which is the only authority on whether
 * the blob or our reading of it is at fault.
 *
 *   bun tools/harness.ts effectShaderBlobs > blobs.json     (in-guest, once)
 *   bun tools/shader-offline.ts blobs.json [--disasm]
 *
 * --disasm additionally feeds every FAILING blob to tools/d3dx-oracle.ts.
 */
import { compilePixelShader, compileVertexShader } from "../src/worker/backends/webgpu/d3d9/shader/link";

type Blob = {
    effect: string; objectIndex: number; stage: "vertex" | "pixel";
    bytes: number; version: string; base64: string;
};

const [file, ...flags] = process.argv.slice(2);
if (!file) {
    console.error("usage: bun tools/shader-offline.ts <blobs.json> [--disasm]");
    process.exit(2);
}
const raw = await Bun.file(file).text();
// The harness CLI prints a journal line before the JSON.
const blobs: Blob[] = JSON.parse(raw.slice(raw.indexOf(raw.includes("[") ? "[" : "{")));

const tokensOf = (b64: string): Uint32Array => {
    const bin = Buffer.from(b64, "base64");
    const pad = bin.length & 3 ? 4 - (bin.length & 3) : 0;
    const buf = pad ? Buffer.concat([bin, Buffer.alloc(pad)]) : bin;
    return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
};

const failures: Array<Blob & { error: string }> = [];
let ok = 0;
for (const b of blobs) {
    try {
        const tokens = tokensOf(b.base64);
        if (b.stage === "vertex") compileVertexShader(tokens);
        else compilePixelShader(tokens);
        ok++;
    } catch (e) {
        failures.push({ ...b, error: e instanceof Error ? e.message : String(e) });
    }
}

console.log(`${blobs.length} blobs: ${ok} compile, ${failures.length} fail`);
const byError = new Map<string, number>();
for (const f of failures) byError.set(f.error, (byError.get(f.error) ?? 0) + 1);
for (const [err, n] of [...byError].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${err}`);
for (const f of failures) {
    console.log(`  ${f.effect} obj ${f.objectIndex} ${f.stage} ${f.bytes}B ${f.version}: ${f.error}`);
}

if (flags.includes("--disasm") && failures.length) {
    const dir = "logs/shader-offline";
    await Bun.$`mkdir -p ${dir}`.quiet();
    for (const f of failures) {
        const path = `${dir}/${f.effect}-${f.objectIndex}-${f.stage}.bin`;
        await Bun.write(path, Buffer.from(f.base64, "base64"));
        console.log(`\n=== ${path} — the shipped d3dx9's own reading:`);
        try {
            const out = await Bun.$`bun tools/d3dx-oracle.ts disasm ${path}`.text();
            console.log(out.split("\n").slice(0, 24).join("\n"));
        } catch (e) {
            console.log(`  oracle refused it too: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
process.exit(failures.length ? 1 : 0);
