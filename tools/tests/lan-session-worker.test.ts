import { expect, test } from "bun:test";
import { SessionWorker } from "../../src/app/session-worker";

test.each([
    { serverUrl: "https://lan.example.org", room: "new-room" },
    null,
])("network changes reach both the active child and its parent: %j", async network => {
    const rootMessages: unknown[] = [];
    const childMessages: unknown[] = [];
    const root = {
        onmessage: null as Worker["onmessage"],
        postMessage(message: unknown) { rootMessages.push(message); },
        terminate() {},
    };
    const worker = new SessionWorker(root as unknown as Worker);
    const channel = new MessageChannel();
    channel.port2.onmessage = event => childMessages.push(event.data);
    try {
        const inherited = { type: "set_network", network: { serverUrl: "https://old.example.org", room: "old" } };
        worker.postMessage(inherited);
        root.onmessage!.call(root as unknown as Worker, new MessageEvent("message", {
            data: { type: "child_session", port: channel.port1 },
        }));
        const changed = { type: "set_network", network };
        worker.postMessage(changed);
        const deadline = Date.now() + 1000;
        while (childMessages.length < 2 && Date.now() < deadline) await Bun.sleep(1);
        expect(rootMessages).toEqual([inherited, changed]);
        expect(childMessages).toEqual([inherited, changed]);
    } finally {
        worker.terminate();
        channel.port2.close();
    }
});
