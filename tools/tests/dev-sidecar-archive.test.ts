/**
 * The dev sidecar's log archive must stay BOUNDED when its writer cannot write.
 *
 * The failure this pins: an unbounded `buffer` turned the guest's log firehose into
 * committed memory the moment an append started failing (a full disk, a deleted logs/),
 * and the retry path `buffer.unshift(...toWrite)` then threw RangeError once the backlog
 * passed the argument-count limit — killing the archive outright. Measured before the fix:
 * 200 MB -> 1.6 GB in ~20 s at 8 MB/s, then dead.
 *
 * So the assertions are: memory bounded, process alive, losses COUNTED, and the gap
 * written into the archive file itself once the writer recovers.
 */
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 3971;
const WORKDIR = join(tmpdir(), `bs-sidecar-test-${process.pid}`);
const LOGS = join(WORKDIR, "logs");
const ENTRY = join(import.meta.dir, "..", "dev-sidecar", "dev-sidecar.ts");

rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(LOGS, { recursive: true });

const child = Bun.spawn(["bun", "run", ENTRY], {
  cwd: WORKDIR,
  env: { ...process.env, BS_SIDECAR_PORT: String(PORT) },
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
afterAll(async () => {
  child.kill();
  await child.exited;
  // Windows keeps the child's cwd locked for a moment after it dies; a leftover temp dir
  // must not fail the suite.
  try { rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* the OS will reap it */ }
});

interface Stats {
  rss: number;
  sessions: Array<{ bufferedChars: number; droppedLines: number; writeErrors: number; bytesWritten: number }>;
}
const stats = async (): Promise<Stats> => (await fetch(`http://127.0.0.1:${PORT}/stats`)).json() as Promise<Stats>;

/** Private bytes read from OUTSIDE the process: the memory assertion must hold whether or
 *  not the process is well enough to answer /stats. */
function privateBytes(): number {
  if (process.platform !== "win32") {
    try {
      const statm = readFileSync(`/proc/${child.pid}/statm`, "utf8").split(" ");
      return Number(statm[1]) * 4096;
    } catch { return 0; }
  }
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-Command",
    `try { (Get-Process -Id ${child.pid} -ErrorAction Stop).PrivateMemorySize64 } catch { 0 }`]);
  return Number(new TextDecoder().decode(r.stdout).trim()) || 0;
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error("sidecar did not start");
}

function connect(): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`,
      { headers: { Origin: "http://localhost:5174" } } as unknown as string[]);
    ws.addEventListener("open", () => ok(ws), { once: true });
    ws.addEventListener("error", () => fail(new Error("ws refused")), { once: true });
  });
}

const LINE = "z".repeat(200);
function pump(ws: WebSocket, batches: number, per = 100): number {
  for (let b = 0; b < batches; b++) {
    ws.send(JSON.stringify({
      type: "log_batch",
      entries: Array.from({ length: per }, (_, i) => ({
        timestamp: Date.now(), category: "TEST", level: 3, message: `${b}:${i} ${LINE}`,
      })),
    }));
  }
  return batches * per;
}

await waitHealthy();
const ws = await connect();

test("archives what it is sent", async () => {
  pump(ws, 20);
  await Bun.sleep(1500);
  const s = await stats();
  expect(s.sessions[0]!.bytesWritten).toBeGreaterThan(2000 * 200);
  expect(s.sessions[0]!.bufferedChars).toBe(0);   // nothing stranded once ingest stops
});

test("a writer that cannot write leaves the buffer bounded and the loss counted", async () => {
  rmSync(LOGS, { recursive: true, force: true });
  writeFileSync(LOGS, "not a directory");   // every append now fails, permanently

  const priv0 = privateBytes();
  // ~200 MB of log text at a rate the old code turned into ~1.4 GB of committed memory.
  for (let round = 0; round < 40; round++) {
    pump(ws, 250);
    await Bun.sleep(25);
  }
  await Bun.sleep(1000);

  expect(child.exitCode).toBe(null);                            // still alive (was: RangeError)
  expect(privateBytes() - priv0).toBeLessThan(400 * 1024 * 1024); // was +1.4 GB and climbing

  const s = await stats();
  expect(s.sessions[0]!.writeErrors).toBeGreaterThan(0);
  // The cap is 8 MB of text; allow slack for the chunk that was in flight.
  expect(s.sessions[0]!.bufferedChars).toBeLessThan(20 * 1024 * 1024);
  expect(s.sessions[0]!.droppedLines).toBeGreaterThan(0);       // counted, not silent
}, 30_000);

test("recovers and states the gap in the archive itself", async () => {
  rmSync(LOGS, { force: true });
  mkdirSync(LOGS, { recursive: true });
  pump(ws, 5);
  await Bun.sleep(2000);

  const s = await stats();
  expect(s.sessions[0]!.writeErrors).toBe(0);
  expect(existsSync(LOGS)).toBe(true);

  let gap = "";
  for (const f of readdirSync(LOGS)) {
    const text = await Bun.file(join(LOGS, f)).text();
    const hit = text.split("\n").find((l) => l.startsWith("[ARCHIVE GAP]"));
    if (hit) gap = hit;
  }
  expect(gap).toMatch(/^\[ARCHIVE GAP\] \d+ lines \(\d+ chars\) dropped since /);
}, 20_000);
