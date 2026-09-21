/**
 * "Is something blocking?" must have ONE answer.
 *
 * `report().pendingModals` is built in the worker from the guest's MessageBox bridge,
 * so it can only see dialogs the GUEST raised. A HOST dialog — the storage manager,
 * the WGB wizard, a manifest editor — is page DOM: it sits over the canvas, eats the
 * clicks a chain sends, and appears nowhere in the report. A chain blocked by one was
 * indistinguishable from a chain that was merely slow, which is the single property a
 * diagnostic must not have.
 *
 * The facade folds the host census into the same list (tagged by `source`) and the
 * load verb refuses rather than stalling behind a dialog it cannot dismiss.
 */
import { expect, test, beforeAll } from "bun:test";

let harness: any;
let lastRpc: { cmd: string; args: unknown[] } | null = null;

beforeAll(async () => {
    const store = new Map<string, string>();
    const fakeStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    const g = globalThis as any;
    g.window = g.window ?? { location: { search: "" } };
    g.sessionStorage = fakeStorage;
    g.localStorage = fakeStorage;

    // A worker that answers every harness_rpc with a minimal report.
    const listeners: Array<(e: any) => void> = [];
    const worker = {
        addEventListener: (_t: string, fn: (e: any) => void) => { listeners.push(fn); },
        removeEventListener: () => { },
        postMessage: (m: any) => {
            if (m?.type !== "harness_rpc") return;
            lastRpc = { cmd: m.cmd, args: m.args };
            const result = m.cmd === "report"
                ? { eip: 0x401000, pendingModals: [{ id: 1, text: "Disk error", caption: "Setup", uType: 0, waitingMs: 40 }] }
                : {};
            queueMicrotask(() => {
                for (const fn of listeners) fn({ data: { type: "harness_reply", id: m.id, ok: true, result } });
            });
        },
    };
    const { installHarnessFacade } = await import("../../src/harness/facade");
    harness = installHarnessFacade(worker as unknown as Worker);
});

test("with no host modal, report() carries the guest's own and says so", async () => {
    const r = await harness.report() as any;
    expect(r.hostModals).toEqual([]);
    expect(r.pendingModals).toHaveLength(1);
    expect(r.pendingModals[0]).toMatchObject({ caption: "Setup", source: "guest" });
});

test("a registered host modal appears in pendingModals, tagged as host", async () => {
    harness.setHostModal("storageManager", { caption: "Storage" });
    try {
        const r = await harness.report() as any;
        expect(r.hostModals.map((m: any) => m.name)).toEqual(["storageManager"]);
        const bySource = Object.fromEntries(r.pendingModals.map((m: any) => [m.source, m]));
        // BOTH halves, in one list — that is the whole point.
        expect(bySource.guest.caption).toBe("Setup");
        expect(bySource.host.name).toBe("storageManager");
        expect(typeof bySource.host.waitingMs).toBe("number");
    } finally { harness.setHostModal("storageManager", null); }
});

test("closing the modal removes it again", async () => {
    harness.setHostModal("wgbWizard", { caption: "Add a game" });
    harness.setHostModal("wgbWizard", null);
    const r = await harness.report() as any;
    expect(r.hostModals).toEqual([]);
    expect(r.pendingModals.every((m: any) => m.source === "guest")).toBe(true);
});

test("hostModals() is also answerable on its own", () => {
    harness.setHostModal("manifestEditor", { caption: "Edit manifest", text: "gothic" });
    try {
        const { modals } = harness.hostModals();
        expect(modals).toHaveLength(1);
        expect(modals[0]).toMatchObject({ name: "manifestEditor", caption: "Edit manifest", text: "gothic" });
    } finally { harness.setHostModal("manifestEditor", null); }
});

test("openWgb REFUSES behind a host modal instead of stalling on it", async () => {
    harness.setHostModal("wgbWizard", { caption: "Add a game" });
    try {
        await harness.openWgb("demo");
        throw new Error("openWgb should have refused");
    } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("a host modal is on screen");
        expect(msg).toContain("wgbWizard");
        expect(msg).toContain("Add a game");
        // It must fail BEFORE attempting the load, not after a 120s stall.
        expect((e as Error & { code?: string }).code).toBe("UNSUPPORTED");
    } finally { harness.setHostModal("wgbWizard", null); }
});

test("report forwards its own args to the worker untouched", async () => {
    lastRpc = null;
    await harness.report(0x12ff00);
    expect(lastRpc).toMatchObject({ cmd: "report", args: [0x12ff00] });
});
