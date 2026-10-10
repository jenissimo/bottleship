import type { CdpSession } from "./cdp-core";

type WorkerTransport = Pick<CdpSession, "send" | "on" | "off">;

/** Auto-attach is scoped to the connected page, including its existing workers. */
export async function attachEmulatorWorker(session: WorkerTransport, timeoutMs = 15_000): Promise<string> {
    let resolveWorker!: (id: string) => void;
    let rejectWorker!: (error: Error) => void;
    const found = new Promise<string>((resolve, reject) => { resolveWorker = resolve; rejectWorker = reject; });
    const attached = new Map<string, { sessionId: string; url: string }>();
    const match = (info: any) => {
        if (info?.type === "worker" && /(?:^|\/)emulator\.worker(?:[.-]|\?|$)/.test(info.url ?? "")) {
            const worker = attached.get(info.targetId);
            if (worker) resolveWorker(worker.sessionId);
        }
    };
    const onAttach = (params: any) => {
        if (params?.targetInfo?.type !== "worker") return;
        attached.set(params.targetInfo.targetId, { sessionId: params.sessionId, url: params.targetInfo.url ?? "" });
        match(params.targetInfo);
    };
    const onInfo = (params: any) => match(params?.targetInfo);
    session.on("Target.attachedToTarget", onAttach);
    session.on("Target.targetInfoChanged", onInfo);
    const timer = setTimeout(() => rejectWorker(new Error(`no emulator worker attached to this page; related workers: ${
        [...attached.entries()].map(([id, worker]) => `${id}:${worker.url || "(no URL)"}`).join(", ") || "none"}`)), timeoutMs);
    try {
        const enabled = session.send("Target.setAutoAttach", {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        }, undefined, { timeoutMs }).then(() => {
            // A busy renderer may omit the URL. A single related worker is unambiguous.
            if (attached.size === 1) {
                const worker = attached.values().next().value!;
                if (!worker.url) resolveWorker(worker.sessionId);
            }
        });
        const [id] = await Promise.all([found, enabled]);
        return id;
    } finally {
        clearTimeout(timer);
        session.off("Target.attachedToTarget", onAttach);
        session.off("Target.targetInfoChanged", onInfo);
    }
}
