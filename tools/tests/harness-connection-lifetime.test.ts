/**
 * Exercise the real harness SDK and CdpSession over a finite loopback CDP endpoint.
 * A child must release its sockets and exit naturally: process.exit() would hide the leak.
 */
import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { resolve } from "node:path";

type Mode = "concurrent" | "pending" | "overlap" | "retry" | "reopen";
type Connection = ServerWebSocket<{ lookup: number }>;

async function exercise(mode: Mode) {
    let lists = 0;
    let opens = 0;
    let closes = 0;
    const sockets = new Set<Connection>();
    const held = new Map<number, () => void>();
    const hold = mode === "pending" ? [1] : mode === "overlap" ? [1, 2] : [];
    const server = Bun.serve<{ lookup: number }>({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === "/state") return Response.json({ lists, opens, closes });
            if (url.pathname.startsWith("/release/")) {
                held.get(Number(url.pathname.split("/").at(-1)))?.();
                return new Response("ok");
            }
            if (url.pathname === "/json/list") {
                const lookup = ++lists;
                if (hold.includes(lookup)) {
                    await new Promise<void>((resolve) => held.set(lookup, resolve));
                }
                const targets = mode === "retry" && lookup === 1 ? [] : [{
                    id: "fixture-page",
                    type: "page",
                    url: "http://fixture.invalid/?game=dev&bs=connection-fixture",
                    webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp?lookup=${lookup}`,
                }];
                return Response.json(targets);
            }
            if (url.pathname === "/cdp" && server.upgrade(request, {
                data: { lookup: Number(url.searchParams.get("lookup")) },
            })) return;
            return new Response("not found", { status: 404 });
        },
        websocket: {
            open(socket) {
                opens++;
                sockets.add(socket);
            },
            message(socket, message) {
                const request = JSON.parse(String(message));
                if (request.method !== "Runtime.evaluate") {
                    throw new Error("Unexpected CDP command " + request.method);
                }
                socket.send(JSON.stringify({
                    id: request.id,
                    result: { result: { type: "boolean", value: true } },
                }));
            },
            close(socket) {
                closes++;
                sockets.delete(socket);
            },
        },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const child = Bun.spawn([
        process.execPath,
        resolve(import.meta.dir, "fixtures/harness-connection-client.ts"),
        endpoint,
        mode,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const capture = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    let ended = false;
    const exit = child.exited.then((code) => {
        ended = true;
        return code;
    });
    let natural = false;
    let beforeCleanup: { lists: number; opens: number; closes: number; live: number };
    try {
        const deadline = Date.now() + 3500;
        while (!ended && Date.now() < deadline) await Bun.sleep(5);
        natural = ended;
        // Record the leak BEFORE owned forced cleanup closes any remaining socket.
        beforeCleanup = { lists, opens, closes, live: sockets.size };
    } finally {
        for (const release of held.values()) release();
        if (!ended) child.kill();
        await exit;
        for (const socket of sockets) socket.close();
        await server.stop(true);
    }
    const [stdout, stderr] = await capture;
    const marker = "@@HARNESS_LIFETIME@@";
    const line = stdout.split(/\r?\n/).find((line) => line.startsWith(marker));
    const value = line ? JSON.parse(line.slice(marker.length)) : undefined;
    const observation = {
        mode, beforeCleanup, natural, code: await exit, terminal: !!line, value, stderr,
    };
    console.log("HARNESS_LIFETIME_OBSERVED " + JSON.stringify(observation));
    return observation;
}

describe("harness CDP connection ownership", () => {
    test("four cold concurrent runs own one connection and exit naturally", async () => {
        const result = await exercise("concurrent");
        expect(result.terminal).toBe(true);
        expect(result.value.completed).toBe(4);
        expect(result.beforeCleanup).toEqual({ lists: 1, opens: 1, closes: 1, live: 0 });
        expect(result.natural).toBe(true);
        expect(result.code).toBe(0);
    }, 6000);

    test("close revokes a pending acquisition and closes its late connection", async () => {
        const result = await exercise("pending");
        expect(result.value.old.ok).toBe(false);
        expect(result.beforeCleanup).toEqual({ lists: 1, opens: 1, closes: 1, live: 0 });
        expect(result.natural).toBe(true);
        expect(result.code).toBe(0);
    }, 6000);

    test("an old late finish cannot retire or replace a newer pending connection", async () => {
        const result = await exercise("overlap");
        expect(result.value.old.ok).toBe(false);
        expect(result.value.newer.ok).toBe(true);
        expect(result.value.joined.ok).toBe(true);
        expect(result.beforeCleanup).toEqual({ lists: 2, opens: 2, closes: 2, live: 0 });
        expect(result.natural).toBe(true);
        expect(result.code).toBe(0);
    }, 6000);

    test("a failed target lookup permits the next acquisition", async () => {
        const result = await exercise("retry");
        expect(result.value.first.ok).toBe(false);
        expect(result.value.second.ok).toBe(true);
        expect(result.beforeCleanup).toEqual({ lists: 2, opens: 1, closes: 1, live: 0 });
        expect(result.natural).toBe(true);
        expect(result.code).toBe(0);
    }, 6000);

    test("close then reopen owns and releases the next connection", async () => {
        const result = await exercise("reopen");
        expect(result.value.first.ok).toBe(true);
        expect(result.value.second.ok).toBe(true);
        expect(result.beforeCleanup).toEqual({ lists: 2, opens: 2, closes: 2, live: 0 });
        expect(result.natural).toBe(true);
        expect(result.code).toBe(0);
    }, 6000);
});
