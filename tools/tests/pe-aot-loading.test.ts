import { describe, expect, test } from "bun:test";
import { SessionWorker } from "../../src/app/session-worker";
import { peAotStageLabel, updatePeAotLoadingStatus, type PeAotLoadingStatus } from "../../src/app/pe-aot-loading";
import type { PeAotProgress, PeAotStatus } from "../../src/worker/wwt/pe-aot-progress";

function message(launchId: number, attempt: number, module: string, status: PeAotStatus): PeAotProgress {
    return { type: "pe_aot_progress", launchId, attempt, module, ...status };
}

describe("PE AOT loading status", () => {
    test("tracks concurrent modules through cold compilation and a cache hit", () => {
        let state: PeAotLoadingStatus | undefined;
        const cold = (status: PeAotStatus) => message(1, 1, "game.exe", status);
        const warm = (status: PeAotStatus) => message(1, 2, "render.dll", status);
        const compiling = cold({ phase: "compiling", startedAt: 1234, work: { stage: "lift", completed: 128 } });
        for (const event of [cold({ phase: "lookup" }), cold({ phase: "starting" }), compiling, warm({ phase: "lookup" })]) {
            state = updatePeAotLoadingStatus(state, event);
        }
        expect(peAotStageLabel(compiling)).toBe("Translating functions");
        const cacheHit = warm({ phase: "finalizing", source: "cache" });
        state = updatePeAotLoadingStatus(state, cacheHit);
        expect(peAotStageLabel(state!.pending.at(-1)!)).toBe("Cache hit, installing");

        const cached = warm({ phase: "ready", source: "cache" });
        state = updatePeAotLoadingStatus(state, cached);
        expect(state?.pending).toEqual([compiling]);
        expect(peAotStageLabel(state!.results[0])).toBe("Ready from cache");

        const compiled = cold({ phase: "ready", source: "compiler" });
        state = updatePeAotLoadingStatus(state, compiled);
        expect(state?.pending).toEqual([]);
        expect(state?.results).toEqual([cached, compiled]);
        expect(peAotStageLabel(state!.results[1])).toBe("Compilation ready");
    });

    test("ends a timed-out attempt without reporting completion", () => {
        const start = message(1, 3, "engine.dll", { phase: "lookup" });
        const timeout = message(1, 3, "engine.dll", { phase: "fallback", reason: "timeout", budgetMs: 30_000 });
        const state = updatePeAotLoadingStatus(updatePeAotLoadingStatus(undefined, start), timeout);
        expect(state?.pending).toEqual([]);
        expect(peAotStageLabel(state!.results[0])).toBe("Timed out after 30s, using demand translation");
        expect(updatePeAotLoadingStatus(undefined, timeout)).toBeUndefined();
    });

    test("clears status on game switch and drops progress from the prior launch", () => {
        const sent: { launchId: number }[] = [];
        const root = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (data: { launchId: number }) => sent.push(data) };
        const worker = new SessionWorker(root as unknown as Worker);
        let state: PeAotLoadingStatus | undefined;
        worker.onmessage = ({ data }) => {
            if (data.type === "child_session_reset" && data.freshLaunch) state = undefined;
            if (data.type === "pe_aot_progress") state = updatePeAotLoadingStatus(state, data);
        };
        const send = (launchId: number, attempt: number, module: string, status: PeAotStatus) => {
            root.onmessage!(new MessageEvent("message", { data: message(launchId, attempt, module, status) }));
        };

        worker.postMessage({ type: "load_bundle" });
        const first = sent[0].launchId;
        send(first, 1, "old.exe", { phase: "lookup" });
        expect(state).toBeDefined();

        worker.postMessage({ type: "load_pe" });
        const second = sent[1].launchId;
        expect(second).not.toBe(first);
        expect(state).toBeUndefined();
        send(first, 2, "old.dll", { phase: "compiling", startedAt: 1234, work: { stage: "emit", completed: 64, total: 100 } });
        expect(state).toBeUndefined();
        send(second, 3, "new.exe", { phase: "lookup" });
        send(first, 1, "old.exe", { phase: "ready", source: "compiler" });
        expect(state).toEqual({ pending: [message(second, 3, "new.exe", { phase: "lookup" })], results: [] });
    });
});
