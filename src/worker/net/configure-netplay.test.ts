/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createLanServer } from "../../../packages/lan/src/server";
import { configureNetplay, getNetplayState } from "./configure-netplay";
import { lanNetwork } from "./lan-network";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 4000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("Network state timed out");
        await pause(5);
    }
}
test("configuration is idempotent online and awaits a new ready after disconnect", async () => {
    const server = createLanServer({ port: 0 });
    const port = await server.listen(), config = { serverUrl: "http://127.0.0.1:" + port, room: "configure" };
    let joins = 0;
    server.io.on("connection", () => joins++);
    try {
        await configureNetplay(config);
        expect(getNetplayState().connected).toBe(true);
        await configureNetplay(config);
        expect(joins).toBe(1);
        const original = getNetplayState();
        server.io.disconnectSockets(true);
        await until(() => !lanNetwork.connected);
        const reconnect = configureNetplay(config);
        expect(lanNetwork.connected).toBe(false);
        await reconnect;
        expect(lanNetwork.connected).toBe(true);
        expect(joins).toBe(2);
        expect(getNetplayState().generation).toBeGreaterThan(original.generation);
        expect(getNetplayState().node).toEqual(original.node);
        await expect(configureNetplay({ serverUrl: config.serverUrl, room: "invalid room" })).rejects.toThrow();
        expect(lanNetwork.connected).toBe(true);
    } finally { await configureNetplay(null); await server.close(); }
    expect(getNetplayState().connected).toBe(false);
}, 10_000);
