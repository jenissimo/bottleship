import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomTurnConfig } from "../../packages/lan/src/room-comms-server";
import { createPublicLanServer } from "../../packages/lan/test/public-server";

const url = Bun.env.BS_TURN_SMOKE_URL ?? "";
const secret = Bun.env.BS_TURN_SMOKE_SECRET ?? "";
if (!/^turn:127\.0\.0\.1:\d{1,5}\?transport=(udp|tcp)$/.test(url) || secret.length < 32) {
    throw new Error("Set BS_TURN_SMOKE_URL to turn:127.0.0.1:PORT?transport=udp or tcp and provide a disposable BS_TURN_SMOKE_SECRET");
}
const chromePath = Bun.env.BS_TURN_SMOKE_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
if (!chromePath) throw new Error("Set BS_TURN_SMOKE_CHROME to a Chrome or Chromium executable");

const turnEnv = {
    BS_LAN_TURN_URLS: url,
    BS_LAN_TURN_SECRET: secret,
    BS_LAN_TURN_TTL_SECONDS: "60",
    BS_LAN_TURN_ALLOW_PUBLIC: "true",
};
const build = await Bun.build({ entrypoints: [join(import.meta.dir, "turn-smoke-browser.ts")],
    target: "browser", format: "esm" });
if (!build.success) throw new Error("Unable to bundle the room voice smoke");

type BrowserTarget = { type: string; url: string; webSocketDebuggerUrl: string };
type Evaluation = { id: number; result?: { result?: { value?: string } } };

async function readReport(profile: string, origin: string): Promise<{ pass: boolean }> {
    const deadline = Date.now() + 35_000;
    let target: BrowserTarget | undefined;
    while (!target && Date.now() < deadline) {
        const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0];
        if (port) {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
            const targets = await response.json() as BrowserTarget[];
            target = targets.find(item => item.type === "page" && item.url.startsWith(origin + "/"));
        }
        if (!target) await Bun.sleep(100);
    }
    if (!target) throw new Error("Smoke browser did not open its local page");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Chrome debugging handshake timed out")), 3000);
            ws.onopen = () => { clearTimeout(timer); resolve(); };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("Chrome debugging handshake failed")); };
        });
        let id = 0;
        while (Date.now() < deadline) {
            const sequence = ++id;
            const content = await new Promise<string | undefined>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Chrome debugging command timed out")), 3000);
                ws.onmessage = event => {
                    const packet = JSON.parse(event.data) as Evaluation;
                    if (packet.id !== sequence) return;
                    clearTimeout(timer);
                    resolve(packet.result?.result?.value);
                };
                ws.send(JSON.stringify({ id: sequence, method: "Runtime.evaluate",
                    params: { expression: "document.body?.textContent", returnByValue: true } }));
            });
            const report = content?.trim();
            if (report?.startsWith("{")) return JSON.parse(report) as { pass: boolean };
            await Bun.sleep(200);
        }
        throw new Error("Chrome did not complete the room voice smoke");
    } finally {
        ws.close();
    }
}

async function startLan(origin: string): Promise<{ port: number; stop(): Promise<void> }> {
    const rustPath = Bun.env.BS_TURN_SMOKE_RUST;
    if (!rustPath) {
        const lan = createPublicLanServer({ host: "127.0.0.1", port: 0, allowedOrigins: [origin],
            roomTurn: RoomTurnConfig.fromEnvironment(turnEnv) });
        return { port: await lan.listen(), stop: () => lan.close() };
    }

    const child = Bun.spawn([rustPath, "--host", "127.0.0.1", "--port", "0", "--origin", origin, "--public-rooms"],
        { env: { ...turnEnv, SystemRoot: Bun.env.SystemRoot, PATH: Bun.env.PATH }, stdout: "pipe", stderr: "inherit" });
    const stop = async () => { child.kill(); await child.exited; };
    const timer = setTimeout(() => child.kill(), 5000);
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) throw new Error("Rust LAN relay exited before binding its smoke port");
            pending += next.value;
            const lines = pending.split("\n");
            pending = lines.pop()!;
            for (const line of lines) {
                if (!line.startsWith("{")) continue;
                const ready = JSON.parse(line) as { port?: number };
                if (ready.port) return { port: ready.port, stop };
            }
        }
    } catch (error) {
        await stop();
        throw error;
    } finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}

const profile = await mkdtemp(join(tmpdir(), "bottleship-turn-smoke-"));
const page = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
        if (new URL(request.url).pathname === "/browser.js") {
            return new Response(build.outputs[0], { headers: { "Content-Type": "text/javascript" } });
        }
        return new Response('<!doctype html><body>waiting<script type="module" src="/browser.js"></script></body>',
            { headers: { "Content-Type": "text/html" } });
    },
});
const origin = `http://127.0.0.1:${page.port}`;
let lan: Awaited<ReturnType<typeof startLan>> | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
try {
    lan = await startLan(origin);
    const relay = `http://127.0.0.1:${lan.port}`;
    chrome = Bun.spawn([chromePath, "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-gpu", "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0", "--user-data-dir=" + profile,
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required", origin + "/?relay=" + encodeURIComponent(relay)],
        { stdout: "ignore", stderr: "ignore" });
    const report = await readReport(profile, origin);
    console.log(JSON.stringify(report));
    if (!report.pass) throw new Error("Browser TURN smoke failed");
} finally {
    if (chrome) {
        chrome.kill();
        await chrome.exited;
    }
    await lan?.stop();
    page.stop(true);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
