/**
 * Quality-gate check: the video plane has exactly ONE composite policy.
 *
 * The plane is a compensation layer — real Bink/Smacker present nothing, so it exists only
 * for the shape where the app's own upload path loses the decoded pixels. Compositing it is
 * destructive: it covers the whole frame the guest just drew. Six present paths reach the
 * screen (the rAF GDI loop, the DDraw presenter's 2D and GPU paths, D3D8, D3D9, Glide), and
 * when each decided for itself from "the plane still holds a bitmap" they disagreed about
 * when it STOPS being on screen — a finished movie over a menu, repeatedly.
 *
 * The single owner is `src/worker/video/video-plane-policy.ts` (`getVideoPlanePlan`), the way
 * `getOverlayCompositePlan` owns the GDI/window plane. This check pins the ownership the same
 * way `validate-guest-code-writes.ts` pins its chokepoint: outside the video module itself,
 * nothing may read the overlay service's pixels or its content flag.
 *
 * Scope, deliberately: OWNERSHIP, not coverage. Whether a given `blit()` draws the plane is
 * dataflow; what is checkable is that no one but the policy can obtain the plane to draw, so
 * a present path that wants it has to go through the policy to get it.
 *
 * Usage: bun tools/validate-video-plane-policy.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** The video module owns its own plane; everything else asks the policy. */
const OWNER_DIR = join("src", "worker", "video") + sep;

/**
 * The one handle on the plane. Checking THIS rather than the accessors it leads to is what
 * makes the check exact: the service is invariably reached through it, while a predicate on
 * `.hasContent()` would have to follow a local alias across a whole file and could not.
 * Anything a caller legitimately needs (the plan, the dirty flag, the composite ack) is a
 * named export of video-plane-policy.ts, and reporting reads `getDebugInfo()` off the router.
 */
const SERVICE_ACCESS = /getOverlayService\s*\(/;

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
    }
}

const violations: string[] = [];
let owners = 0;

for (const file of walk(SRC)) {
    const rel = relative(ROOT, file).split("/").join(sep);
    if (rel.startsWith(OWNER_DIR)) { owners++; continue; }

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name it
        if (!SERVICE_ACCESS.test(line)) return;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
}

if (owners === 0) {
    console.error(`No files under ${OWNER_DIR} — the policy owner moved; this check is asserting nothing.`);
    process.exit(1);
}

if (violations.length > 0) {
    console.error("The video plane's pixels must come from video/video-plane-policy.ts");
    console.error("(getVideoPlanePlan — see the header there for why a present path may not decide for itself).\n");
    for (const v of violations) console.error(`  ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
}

console.log(`Video-plane composite policy OK — one owner (${owners} file(s) under ${OWNER_DIR}), no private predicates.`);
