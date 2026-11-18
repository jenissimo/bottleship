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

test("room communications stay with the admitted root while a child holds the display", async () => {
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
    const received: unknown[] = [];
    worker.onmessage = event => received.push(event.data);
    function fromRoot(data: unknown) {
        root.onmessage!.call(root as unknown as Worker, new MessageEvent("message", { data }));
    }
    try {
        fromRoot({ type: "child_session", port: channel.port1 });
        const command = { type: "room_comms_send", request: { kind: "voiceJoin" } };
        worker.postMessage(command);
        expect(rootMessages).toEqual([command]);

        const admitted = { type: "room_comms_update", update: { kind: "available", enabled: true } };
        fromRoot(admitted);
        channel.port2.postMessage({ type: "room_comms_update", update: { kind: "available", enabled: false } });
        const presentation = { type: "window_title", title: "Game" };
        channel.port2.postMessage(presentation);
        const deadline = Date.now() + 1000;
        while (!received.some(message => (message as { type?: string }).type === "window_title") && Date.now() < deadline) await Bun.sleep(1);
        expect(received.slice(1)).toEqual([admitted, presentation]);
        expect(childMessages).toEqual([]);
    } finally {
        worker.terminate();
        channel.port2.close();
    }
});
