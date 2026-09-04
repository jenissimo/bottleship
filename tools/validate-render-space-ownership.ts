/**
 * Quality-gate check: the host canvas size may not become a guest-space quantity.
 *
 * A graphics backend juggles two coordinate spaces that are easy to spell identically.
 * GUEST LOGICAL space is what the app asked for (the D3D9 backbuffer extent, the DDraw
 * primary's dims, grSstScreenWidth/Height); every guest-visible quantity lives there —
 * the viewport, the scissor box, the XYZRHW/NDC divisor, and the extent a LockRect /
 * GetRenderTargetData readback owes its caller. PHYSICAL space is how many samples that
 * logical frame is rendered with, and the HOST CANVAS is a third thing again: sized by the
 * host container/DPI, and related to the guest picture only by the present pass that fits
 * one into the other (shared/present-geometry.ts).
 *
 * D3D9 conflated the last two: `getCurrentTargetSize()` answered with the canvas, so a
 * 640x480 game rasterized into a 640x480 viewport inside a canvas-sized offscreen and was
 * presented 1:1 — the picture in the top-left corner, black to the right and below. Nothing
 * in the backend could notice, because every value involved was a plausible pixel count.
 *
 * The rule this pins, in the shape of validate-guest-code-writes.ts: OWNERSHIP, not
 * coverage. Whether a particular number is "guest space" is dataflow and not checkable;
 * what is checkable is WHO may read the canvas at all. Reading it is allowed only in the
 * present path (fit the frame onto the canvas) and in the internal-resolution resolver
 * (decide the physical sample count) — a pinned census of file+member pairs. Viewport,
 * scissor, RHW and readback code cannot reach the canvas without adding itself here, and
 * adding itself here is the review.
 *
 * Usage: bun tools/validate-render-space-ownership.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Where the two spaces meet, and therefore where the confusion is possible. */
const SCOPES = [
    join("src", "worker", "backends", "webgpu"),
    join("src", "worker", "modules", "d3d9"),
    // The header names the DDraw primary's dims and Glide's screen dims as guest space too,
    // so the modules that own them are in scope or the rule holds only where it was written.
    join("src", "worker", "modules", "ddraw"),
    join("src", "worker", "modules", "glide2x"),
];

/**
 * A read of the HOST CANVAS's backing size. `.canvas` alone is not it — the video plane, a
 * GDI DC and the DDraw presenter's staging surface are OffscreenCanvases of their own, and
 * handing the backend `process.canvas` at init is not a coordinate. What IS a read: the
 * accessor, a GPU CONTEXT's `.canvas` narrowed to OffscreenCanvas (how the host canvas is
 * reached from any local alias — a GDI DC's own 2D context is not that), and any
 * `.width`/`.height` taken off a canvas.
 *
 * `this.canvas` is excluded by the lookbehind: a presenter's OWN `canvas` field is its
 * guest-sized staging surface, and matching it would report the opposite of a violation.
 * The host canvas always arrives through something else (`process.canvas`, `ctx.canvas`).
 */
const CANVAS_READ = [
    /\bgetCanvasSize\s*\(/,
    /(?:\bcontext|\bgetContext\(\))\s*[!?]?\s*\.\s*canvas\b(?=.*\bas\s+OffscreenCanvas\b)/,
    /(?<!\bthis)\.canvas\s*[!?]?\s*\.\s*(?:width|height)\b/,
];

/**
 * The census: `<file>#<member>` allowed to read the canvas.
 *
 * Every entry is either the present pass that fits the guest frame onto the canvas, the
 * resolver that turns the canvas size into ONE internal-scale factor, or the accessor that
 * answers with the canvas itself. Nothing here computes a viewport, a scissor box, an RHW
 * divisor or a readback extent.
 */
const ALLOWED = new Set<string>([
    // The backend's own canvas accessors + the one present call that publishes a content rect.
    "src/worker/backends/webgpu/webgpu-backend.ts#getScreenCanvas",
    "src/worker/backends/webgpu/webgpu-backend.ts#publishGuestPresentRect",
    "src/worker/backends/webgpu/webgpu-backend.ts#getCanvasSize",
    "src/worker/backends/webgpu/webgpu-backend.ts#renderOverlay",
    "src/worker/backends/webgpu/webgpu-backend.ts#blitRects",
    "src/worker/backends/webgpu/webgpu-backend.ts#drawTexture",
    "src/worker/backends/webgpu/webgpu-backend.ts#renderStatsOverlay",
    // D3D9: the accessor, the guest-size fallback for a device that declared none, and the
    // internal-scale resolver. The present pass reads the swap-chain texture's own extent.
    "src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts#getCanvasSize",
    "src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts#getGuestBackbufferSize",
    "src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts#resolveOffscreenExtent",
    // The renderSpace harness verb REPORTS the canvas as the canvas, side by side with the
    // guest extent — naming the two spaces is the opposite of confusing them.
    "src/worker/backends/webgpu/d3d9/d3d9-device.ts#getRenderSpace",
    // DDraw: the no-WebGPU present. That 2D drawImage IS the present pass, and it owes the
    // same host-sized stretch the GPU one does — the scratch it copies from is guest-sized.
    "src/worker/modules/ddraw/presenter.ts#drawFrame",
    // OpenGL: drawable sizing + the two present routes.
    "src/worker/backends/webgpu/opengl/opengl-backend-executor.ts#getDrawableSize",
    "src/worker/backends/webgpu/opengl/opengl-backend-executor.ts#executeFrame",
    "src/worker/backends/webgpu/opengl/opengl-backend-executor.ts#repaintLastFrame",
]);

/** Class members are declared at one indent level inside a class body in this codebase. */
const MEMBER = /^ {4}(?:(?:private|public|protected|readonly|static|async|abstract|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[<(]/;
/**
 * A method written as an arrow-function PROPERTY. Without this, a canvas read inside one is
 * attributed to the member declared before it and silently inherits that member's allowance
 * — the census would then be pinning a name that is not where the read lives.
 */
const MEMBER_ARROW = /^ {4}(?:(?:private|public|protected|readonly|static|abstract|override|declare)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function\b)/;
/** A top-level function is its own "member" for the same purpose. */
const FUNCTION = /^(?:export\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)/;

function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (full.endsWith(".ts") || full.endsWith(".tsx")) yield full;
    }
}

const violations: string[] = [];
const seen = new Set<string>();
let scanned = 0;

for (const scope of SCOPES) {
    for (const file of walk(join(ROOT, scope))) {
        scanned++;
        const rel = relative(ROOT, file).split(sep).join("/");
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        let member = "<file>";
        lines.forEach((line, i) => {
            const m = MEMBER.exec(line) ?? MEMBER_ARROW.exec(line) ?? FUNCTION.exec(line);
            if (m) member = m[1]!;
            // A comment may name the accessor — this check is about who CALLS it.
            if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
            if (!CANVAS_READ.some((re) => re.test(line))) return;
            const key = `${rel}#${member}`;
            seen.add(key);
            if (ALLOWED.has(key)) return;
            violations.push(`${rel}:${i + 1} (${member}): ${line.trim()}`);
        });
    }
}

if (scanned === 0) {
    console.error(`No sources under ${SCOPES.join(", ")} — the backends moved; this check is asserting nothing.`);
    process.exit(1);
}

const stale = [...ALLOWED].filter((key) => !seen.has(key));

if (violations.length > 0) {
    console.error("The host canvas size is not a guest-space quantity.");
    console.error("Guest space is the backbuffer/primary extent the app asked for: viewport, scissor,");
    console.error("the XYZRHW divisor and every readback extent live there. The canvas is the present");
    console.error("target, and only the present pass and the internal-scale resolver may read it —");
    console.error("see tools/validate-render-space-ownership.ts and shared/internal-resolution.ts.\n");
    for (const v of violations) console.error(`  ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
}

if (stale.length > 0) {
    // An allowance nothing exercises is an allowance nobody reviewed the removal of; it also
    // silently widens the census the next time that member reappears.
    console.error("Stale entries in the canvas-read census (allowed, but nothing reads the canvas there):");
    for (const key of stale) console.error(`  ${key}`);
    process.exit(1);
}

console.log(`Render-space ownership OK — ${seen.size} canvas read site(s), all in the present path`
    + ` or the internal-scale resolver (${scanned} file(s) scanned).`);
