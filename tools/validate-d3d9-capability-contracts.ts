import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const sourceRoot = resolve(repo, "src", "worker");
const CONTRACT_GLOBAL = String.raw`__d3d9(?:Msaa|Float|Volume)CapabilityContract`;
/** Both orders: `globalThis.__d3d9…Contract` AND `"__d3d9…Contract" in globalThis`. A
 *  one-directional window matches only the spelling somebody happened to write first. */
const forbiddenGlobalGate = new RegExp(
    `globalThis[\\s\\S]{0,240}${CONTRACT_GLOBAL}|${CONTRACT_GLOBAL}[\\s\\S]{0,240}globalThis`,
);

function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = resolve(dir, entry);
        if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
        else if (/\.(?:ts|tsx)$/.test(entry)) files.push(path);
    }
    return files;
}

const violations = sourceFiles(sourceRoot)
    .filter(path => forbiddenGlobalGate.test(readFileSync(path, "utf8")))
    .map(path => path.slice(repo.length + 1));
if (violations.length) {
    throw new Error(`D3D9 capability contracts must not be globalThis gates:\n${violations.join("\n")}`);
}

const backend = readFileSync(resolve(sourceRoot, "backends/webgpu/webgpu-backend.ts"), "utf8");
const probeCall = backend.indexOf("await probeD3D9WebGpuCapabilities(device");
if (probeCall < 0) {
    throw new Error("WebGPUBackend must await the live D3D9 capability probe before publishing the device");
}
// A substring match cannot tell an executed call from `if (false) await probe…(device)` — and a
// probe that never runs publishes the device with unmeasured contracts, which is precisely what
// this check exists to prevent. So require it to be a STATEMENT: everything between the previous
// statement boundary and the call must be whitespace (or a plain assignment/void head).
// Comments are blanked (length-preserving, so offsets still line up) — a `;` inside the
// rationale comment above the call would otherwise be read as the statement boundary.
const head = backend.slice(0, probeCall)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
const stmtStart = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
const prefix = head.slice(stmtStart + 1);
if (!/^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*|[\w$.]+\s*=\s*|void\s+)?$/.test(prefix)) {
    throw new Error(
        `WebGPUBackend's capability probe is not an unconditional statement — it is guarded by \`${prefix.trim()}\`. ` +
        "A conditional (or dead) probe publishes the device with unmeasured contracts.",
    );
}

// Call-shaped, not mention-shaped: this file DEFINES these symbols, so a bare name match is
// satisfied by the declaration itself and says nothing about the probe doing the work.
const probe = readFileSync(resolve(sourceRoot, "backends/webgpu/shared/capability-probe.ts"), "utf8");
// `min` is 2 for a symbol this file also declares (declaration + at least one call), 1 for an
// imported one.
for (const [marker, min] of [["probeMsaaSampleCount(", 2], ["probeSampling(", 2], ["setD3D9MsaaCapabilityContract({", 1]] as const) {
    if (probe.split(marker).length - 1 < min) {
        throw new Error(`D3D9 capability probe never calls ${marker.replace(/[({]+$/, "")}`);
    }
}

console.log("D3D9 capability contract validator: PASS — no production global gates; live MSAA/format/3D probe is awaited.");
