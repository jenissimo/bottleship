import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { stopDevServerListener } from "../dev-server-process";

async function server() {
    const child = Bun.spawn([process.execPath, "-e", 'const s=Bun.serve({port:0,fetch:()=>new Response("alive")});console.log(s.port);'], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(first.value).trim());
    if (!port) { child.kill(); throw new Error("fixture server did not report a port"); }
    return { child, url: `http://localhost:${port}/` };
}

test("restarting one dev listener leaves another checkout's server alive", async () => {
    const selected = await server(), other = await server();
    try {
        expect(await (await fetch(selected.url)).text()).toBe("alive");
        expect(await (await fetch(other.url)).text()).toBe("alive");
        stopDevServerListener(selected.url);
        const deadline = Date.now() + 5000;
        while (selected.child.exitCode === null && selected.child.signalCode === null && Date.now() < deadline) await Bun.sleep(20);
        expect(selected.child.exitCode !== null || selected.child.signalCode !== null).toBe(true);
        expect(await (await fetch(other.url)).text()).toBe("alive");
    } finally {
        selected.child.kill(); other.child.kill();
        await Promise.all([selected.child.exited, other.child.exited]);
    }
});

test.skipIf(process.platform === "win32")("missing lsof reports the problem without killing a listener or throwing", async () => {
    const selected = await server(), emptyPath = mkdtempSync(join(tmpdir(), "bs-no-tools-"));
    try {
        const script = `import { stopDevServerListener } from ${JSON.stringify(new URL("../dev-server-process.ts", import.meta.url).pathname)}; stopDevServerListener(${JSON.stringify(selected.url)});`;
        const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: emptyPath }, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(child.stderr).text();
        expect(await child.exited).toBe(0);
        expect(stderr).toContain("Could not stop the listener");
        expect(await (await fetch(selected.url)).text()).toBe("alive");
    } finally {
        selected.child.kill(); await selected.child.exited;
        rmSync(emptyPath, { recursive: true, force: true });
    }
});
