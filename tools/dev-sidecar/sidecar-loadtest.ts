/**
 * Load generator + memory curve for the dev sidecar's log ingest.
 *
 * The sidecar is the only long-lived process in the dev stack that ingests an unbounded
 * stream, so "does its memory track lines ingested?" has to be answerable without loading
 * a game. This spawns its OWN sidecar (its own port, its own cwd, so it never touches the
 * real logs/), pumps `log_batch` at a target byte rate over a real WebSocket, and samples
 * the child's WorkingSet/PrivateBytes once a second — a CURVE, not a reading.
 *
 * Usage:
 *   bun tools/dev-sidecar/sidecar-loadtest.ts [--seconds 60] [--mbps 2] [--conns 1]
 *        [--stdout pipe|ignore|inherit] [--entry <sidecar.ts>] [--port 3011]
 *        [--line-bytes 140] [--batch 50] [--csv out.csv]
 *
 * `--stdout pipe` reproduces a daemon launched with nobody draining its stdout — the shape
 * `start /min` / a detached spawn leaves behind. Compare it against `ignore`.
 *
 * `--break-at <sec>` makes the archive directory unwritable mid-run: the writer starts
 * failing every append and never recovers. That is what a full disk (ENOSPC) or a deleted
 * logs/ looks like to the sidecar, and it is the case where an in-memory buffer either
 * stays bounded or eats the machine.
 */

import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
function flag(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
}
function has(name: string): boolean { return args.includes(`--${name}`); }

const SECONDS = Number(flag("seconds", "60"));
const MBPS = Number(flag("mbps", "2"));
const CONNS = Number(flag("conns", "1"));
const PORT = Number(flag("port", "3011"));
const LINE_BYTES = Number(flag("line-bytes", "140"));
const BATCH = Number(flag("batch", "50"));
const STDOUT = flag("stdout", "ignore") as "pipe" | "ignore" | "inherit";
const ENTRY = resolve(flag("entry", join(import.meta.dir, "dev-sidecar.ts")));
const CSV = flag("csv", "");
const LABEL = flag("label", "");
const BREAK_AT = Number(flag("break-at", "0"));
const HEAL_AT = Number(flag("heal-at", "0"));
/** Sender-side cap: past this the sidecar is not draining and we are measuring OUR queue. */
const MAX_BUFFERED = 8 * 1024 * 1024;

const WORKDIR = join(tmpdir(), `bs-sidecar-load-${process.pid}-${PORT}`);
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(join(WORKDIR, "logs"), { recursive: true });

const child = Bun.spawn(["bun", "run", ENTRY], {
  cwd: WORKDIR,
  env: { ...process.env, BS_SIDECAR_PORT: String(PORT) },
  stdin: "ignore",
  stdout: STDOUT,
  stderr: STDOUT === "pipe" ? "pipe" : STDOUT,
});
// The whole point of `--stdout pipe` is that NOBODY reads it. Do not touch child.stdout.

async function waitHealthy(deadlineMs = 20_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error("sidecar never became healthy");
}

/** WorkingSet64 / PrivateMemorySize64 for a pid, sampled by one long-lived helper. */
function memSampler(pid: number): { read(): { ws: number; priv: number } | null; stop(): void } {
  if (process.platform !== "win32") {
    return {
      read() {
        try {
          const s = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
          const rss = Number(s[1]) * 4096;
          return { ws: rss, priv: rss };
        } catch { return null; }
      },
      stop() { /* nothing to stop */ },
    };
  }
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `while ($true) { try { $p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `Write-Output "$($p.WorkingSet64) $($p.PrivateMemorySize64)" } catch { Write-Output "gone" }; ` +
    `Start-Sleep -Milliseconds 250 }`],
    { stdout: "pipe", stdin: "ignore", stderr: "ignore" });
  let last: { ws: number; priv: number } | null = null;
  (async () => {
    const dec = new TextDecoder();
    let tail = "";
    for await (const chunk of ps.stdout as ReadableStream<Uint8Array>) {
      tail += dec.decode(chunk, { stream: true });
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m) last = { ws: Number(m[1]), priv: Number(m[2]) };
      }
    }
  })();
  return { read: () => last, stop: () => ps.kill() };
}

function openSocket(): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: "http://localhost:5174" },
    } as unknown as string[]);
    ws.addEventListener("open", () => ok(ws), { once: true });
    ws.addEventListener("error", (e) => fail(new Error(`ws error: ${String(e)}`)), { once: true });
  });
}

const MB = 1024 * 1024;
const fmt = (b: number) => (b / MB).toFixed(1);

function archivedBytes(): number {
  const dir = join(WORKDIR, "logs");
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      try { total += statSync(join(dir, f)).size; } catch { /* raced with a rotate */ }
    }
  } catch { return 0; }  // --break-at replaced it with a file
  return total;
}

await waitHealthy();
const sampler = memSampler(child.pid!);
await Bun.sleep(1200);
const idle = sampler.read();

const sockets: WebSocket[] = [];
for (let i = 0; i < CONNS; i++) sockets.push(await openSocket());

// One template line, padded to --line-bytes: the generator must not itself be the cost.
const body = "x".repeat(Math.max(1, LINE_BYTES - 60));
const entryOf = (n: number) => ({
  timestamp: Date.now(),
  category: "LOADTEST",
  level: 3,
  message: `line ${n} ${body}`,
});

const targetBytesPerSec = MBPS * MB;
const targetLinesPerSec = Math.max(1, Math.round(targetBytesPerSec / LINE_BYTES));
const TICK_MS = 20;
const linesPerTick = Math.max(BATCH, Math.round(targetLinesPerSec * TICK_MS / 1000));

let sent = 0, throttledTicks = 0, seq = 0;
const rows: string[] = [];
const header = "t_s,lines_sent,mb_sent,ws_mb,priv_mb,mb_archived,sender_queued_mb";
rows.push(header);
console.log(`[loadtest] entry=${ENTRY}`);
console.log(`[loadtest] pid=${child.pid} port=${PORT} stdout=${STDOUT} conns=${CONNS} target=${MBPS}MB/s (${targetLinesPerSec} lines/s) for ${SECONDS}s`);
console.log(`[loadtest] idle: ws=${fmt(idle?.ws ?? 0)}MB priv=${fmt(idle?.priv ?? 0)}MB`);
console.log(header);

/** Replace logs/ with a plain file: every subsequent append fails, permanently. */
function breakArchive(): void {
  const dir = join(WORKDIR, "logs");
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a directory");
  console.log("[loadtest] archive directory replaced by a file — every append now fails");
}

/** Give the writer its directory back: does the archive recover, and does it SAY it lost lines? */
function healArchive(): void {
  const dir = join(WORKDIR, "logs");
  rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true });
  console.log("[loadtest] archive directory restored — the writer should recover");
}

const t0 = Date.now();
let nextReport = 1000;
let broken = false, healed = false;
while (Date.now() - t0 < SECONDS * 1000) {
  if (BREAK_AT && !broken && Date.now() - t0 >= BREAK_AT * 1000) { broken = true; breakArchive(); }
  if (HEAL_AT && !healed && Date.now() - t0 >= HEAL_AT * 1000) { healed = true; healArchive(); }
  for (const ws of sockets) {
    if (ws.bufferedAmount > MAX_BUFFERED) { throttledTicks++; continue; }
    for (let n = 0; n < linesPerTick / CONNS; n += BATCH) {
      const entries = [];
      for (let k = 0; k < BATCH; k++) entries.push(entryOf(seq++));
      ws.send(JSON.stringify({ type: "log_batch", entries }));
      sent += BATCH;
    }
  }
  await Bun.sleep(TICK_MS);
  const el = Date.now() - t0;
  if (el >= nextReport) {
    nextReport += 1000;
    const m = sampler.read();
    const queued = sockets.reduce((a, s) => a + s.bufferedAmount, 0);
    const row = [
      (el / 1000).toFixed(0), sent, fmt(sent * LINE_BYTES), fmt(m?.ws ?? 0), fmt(m?.priv ?? 0),
      fmt(archivedBytes()), fmt(queued),
    ].join(",");
    rows.push(row);
    console.log(row);
  }
}

// Drain window: how long after the firehose stops does the archive catch up?
console.log("[loadtest] firehose off — draining");
for (let i = 0; i < 20; i++) {
  await Bun.sleep(1000);
  const m = sampler.read();
  const queued = sockets.reduce((a, s) => a + s.bufferedAmount, 0);
  const row = [
    ((Date.now() - t0) / 1000).toFixed(0), sent, fmt(sent * LINE_BYTES), fmt(m?.ws ?? 0),
    fmt(m?.priv ?? 0), fmt(archivedBytes()), fmt(queued),
  ].join(",");
  rows.push(row);
  console.log(row);
  if (queued === 0 && archivedBytes() >= sent * LINE_BYTES * 0.98) break;
}

const stats = await fetch(`http://127.0.0.1:${PORT}/stats`).then(r => r.ok ? r.json() : null).catch(() => null);
if (stats) console.log("[loadtest] /stats:", JSON.stringify(stats));

// A dropped line the archive did not admit to is the failure mode that matters most.
try {
  const dir = join(WORKDIR, "logs");
  for (const f of readdirSync(dir)) {
    const text = await Bun.file(join(dir, f)).text();
    for (const line of text.split("\n")) if (line.startsWith("[ARCHIVE GAP]")) console.log(`[loadtest] ${f}: ${line}`);
  }
} catch { /* the archive dir may still be the broken placeholder */ }

const final = sampler.read();
console.log(`[loadtest] ${LABEL || "run"}: sent=${sent} lines (${fmt(sent * LINE_BYTES)}MB) archived=${fmt(archivedBytes())}MB ` +
  `throttledTicks=${throttledTicks} idlePriv=${fmt(idle?.priv ?? 0)}MB finalPriv=${fmt(final?.priv ?? 0)}MB ` +
  `growth=${fmt((final?.priv ?? 0) - (idle?.priv ?? 0))}MB`);

if (CSV) await Bun.write(CSV, rows.join("\n") + "\n");

for (const ws of sockets) ws.close();
sampler.stop();
child.kill();
await Bun.sleep(500);
if (!has("keep")) rmSync(WORKDIR, { recursive: true, force: true });
process.exit(0);
