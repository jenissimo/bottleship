// Lazy CDN mirror for v86's 9p filesystem in headless Node runs.
//
// v86's Node build reads 9p chunk files (images/arch/<sha256>) strictly from the
// local filesystem (lib.js load_file → fs/promises). The full Arch tree is ~6.3 GB,
// but a benchmark run touches only the files the guest actually opens. This shim
// patches fs.promises so a missing file under the mirror root is fetched from the
// upstream CDN (https://i.copy.sh/arch/), written to disk, then read normally —
// first run is online, every later run is fully offline and deterministic.
//
// module.syncBuiltinESMExports() propagates the patched functions to the
// `import("node:fs/promises")` namespace that libv86 uses internally.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

export function installLazyMirror({ mirrorRoot, cdnBase, verbose = false }) {
    const root = path.resolve(mirrorRoot);
    if (!cdnBase.endsWith("/")) cdnBase += "/";
    const stats = { hits: 0, downloads: 0, bytes: 0 };

    async function ensure(p) {
        if (typeof p !== "string" && !(p instanceof URL)) return;
        const norm = path.resolve(String(p));
        if (!norm.startsWith(root + path.sep) && norm !== root) return;
        if (fs.existsSync(norm)) { stats.hits++; return; }

        const rel = path.relative(root, norm).split(path.sep).join("/");
        const url = cdnBase + rel;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[lazy-mirror] ${url} -> HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(norm), { recursive: true });
        // Atomic-ish: write tmp then rename, so parallel runs never see partial files.
        const tmp = `${norm}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, buf);
        try { fs.renameSync(tmp, norm); }
        catch { fs.rmSync(tmp, { force: true }); } // lost the race: other process won
        stats.downloads++;
        stats.bytes += buf.length;
        if (verbose) console.error(`[lazy-mirror] fetched ${rel} (${buf.length} bytes)`);
    }

    const origReadFile = fsp.readFile;
    const origOpen = fsp.open;
    const origStat = fsp.stat;

    fsp.readFile = async function (p, o) { await ensure(p); return origReadFile.call(fsp, p, o); };
    fsp.open = async function (p, ...a) { await ensure(p); return origOpen.call(fsp, p, ...a); };
    fsp.stat = async function (p, ...a) { await ensure(p); return origStat.call(fsp, p, ...a); };
    syncBuiltinESMExports();

    return stats;
}
