/** Browser OPFS/SAB correctness gate; this is not a performance benchmark. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { harness } from "../../harness";
import { ZipStoreWriter } from "../../internal/zip-store-writer";

const root = resolve("logs", process.env.BS_TAB ?? "streaming-runtime-io");
mkdirSync(root, { recursive: true });
const path = resolve(root, `runtime-io-${Date.now()}.wgb`);
const payload = Uint8Array.from({ length: 24 * 1024 * 1024 }, (_, i) => (i * 11 + (i >>> 20)) & 255);
const writer = new ZipStoreWriter(path);
writer.addBuffer("payload.bin", payload);
const written = writer.finish();
const file = Bun.file(path);
const offsets = [...Array.from({ length: 18 }, (_, ci) => ci * 1024 * 1024), 0];
const ranges = await Promise.all(offsets.map(async start => {
    const end = start + 64 * 1024;
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    return { start, end, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
const port = process.env.BS_IO_VERIFY_PORT ?? "3001";
const url = `http://localhost:${port}/wgb?path=${encodeURIComponent(path)}`;
const result = await harness().reload().call("ioCacheVerify", { url, ranges, fill: true, restart: true }).run();
if (!result.ok) throw new Error(JSON.stringify(result));
const evidence = result.steps.find(step => step.cmd === "ioCacheVerify")?.result as {
    verified: number; localVerified: number; demand: { restarted: boolean; io: { requests: number; chunksNeeded: number; chunksFetchedCold: number; chunksDiskHit: number; netKB: number } };
    filled: { io: { diskChunks: number; diskComplete: boolean; netKB: number } };
};
if (evidence.verified !== ranges.length || evidence.localVerified !== ranges.length
    || !evidence.demand.restarted || evidence.demand.io.requests !== 20 || evidence.demand.io.chunksNeeded !== 20
    || evidence.demand.io.chunksFetchedCold !== 18 || evidence.demand.io.chunksDiskHit !== 2
    || evidence.demand.io.netKB !== 18 * 1024 || !evidence.filled.io.diskComplete
    || evidence.filled.io.diskChunks !== Math.ceil(written.bytes / (1024 * 1024))
    || evidence.filled.io.netKB !== Math.floor(written.bytes / 1024)) throw new Error(`I/O ledger mismatch: ${JSON.stringify(evidence)}`);
await Bun.write(resolve(root, "runtime-io-evidence.json"), JSON.stringify({ url, bytes: written.bytes, ranges, evidence }, null, 2));
console.log(`PASS: ${ranges.length} oracle ranges, restart, disk eviction, fill, promotion and local reopen; ${written.bytes} unique network bytes`);
