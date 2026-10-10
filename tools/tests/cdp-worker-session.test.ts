import { expect, test } from "bun:test";
import { attachEmulatorWorker } from "../cdp-worker-session";

class Transport {
    listeners = new Map<string, Array<(params: any) => void>>();
    methods: string[] = [];
    attach: () => void = () => {};
    failure: Error | null = null;
    on(name: string, listener: (params: any) => void) {
        const list = this.listeners.get(name) ?? [];
        list.push(listener);
        this.listeners.set(name, list);
    }
    off(name: string, listener: (params: any) => void) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter(fn => fn !== listener));
    }
    emit(name: string, params: any) { for (const fn of this.listeners.get(name) ?? []) fn(params); }
    async send(name: string) {
        this.methods.push(name);
        if (this.failure) throw this.failure;
        this.attach();
        return {};
    }
    worker(targetId: string, url: string) {
        this.emit("Target.attachedToTarget", { sessionId: `${targetId}-session`, targetInfo: { targetId, type: "worker", url } });
    }
}

test("worker diagnostics select the emulator among the connected page's related workers", async () => {
    const transport = new Transport();
    transport.attach = () => {
        transport.worker("io", "http://localhost/src/io-worker.ts");
        transport.worker("render", "http://localhost/src/d3d9-render-worker.ts");
        transport.worker("guest", "http://localhost/src/emulator.worker.ts?worker_file&type=module");
    };
    expect(await attachEmulatorWorker(transport, 100)).toBe("guest-session");
    expect(transport.methods).toEqual(["Target.setAutoAttach"]);
    expect([...transport.listeners.values()].flat()).toHaveLength(0);
});

test("an existing worker can publish its URL after attaching", async () => {
    const transport = new Transport();
    transport.attach = () => {
        transport.worker("guest", "");
        transport.emit("Target.targetInfoChanged", { targetInfo: {
            targetId: "foreign", type: "worker", url: "http://localhost/emulator.worker.ts",
        } });
        transport.emit("Target.targetInfoChanged", { targetInfo: {
            targetId: "guest", type: "worker", url: "http://localhost/assets/emulator.worker-123.js",
        } });
    };
    expect(await attachEmulatorWorker(transport, 100)).toBe("guest-session");
});

test("missing local worker times out without selecting a browser-wide fallback", async () => {
    const transport = new Transport();
    transport.attach = () => transport.worker("io", "http://localhost/io-worker.ts");
    await expect(attachEmulatorWorker(transport, 10)).rejects.toThrow("this page");
    expect(transport.methods).toEqual(["Target.setAutoAttach"]);
    expect([...transport.listeners.values()].flat()).toHaveLength(0);
});

test("a sole unlabelled related worker is safe; several unlabelled workers are ambiguous", async () => {
    const single = new Transport();
    single.attach = () => single.worker("guest", "");
    expect(await attachEmulatorWorker(single, 100)).toBe("guest-session");
    const multiple = new Transport();
    multiple.attach = () => { multiple.worker("a", ""); multiple.worker("b", ""); };
    await expect(attachEmulatorWorker(multiple, 10)).rejects.toThrow("a:(no URL), b:(no URL)");
});

test("failed attachment releases event listeners and its deadline", async () => {
    const transport = new Transport();
    transport.failure = new Error("renderer unresponsive");
    await expect(attachEmulatorWorker(transport, 100)).rejects.toThrow("renderer unresponsive");
    expect([...transport.listeners.values()].flat()).toHaveLength(0);
});
