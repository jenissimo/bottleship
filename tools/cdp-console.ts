/**
 * Browser-console capture for the harness CLI: errors/warnings/uncaught exceptions of
 * the page AND the emulator worker over a window, template-deduplicated. The worker
 * log stream does not carry these — a host-side `console.error` is visible nowhere else.
 */
import type { CdpSession } from "./cdp-core";
import { attachEmulatorWorker } from "./cdp-worker-session";

export interface ConsoleTemplate {
    realm: "page" | "worker";
    level: string;
    count: number;
    template: string;
    sample: string;
    where: string;
}

const templateOf = (s: string): string =>
    s.replace(/0x[0-9a-fA-F]+/g, "0xN").replace(/\d+(\.\d+)?/g, "N").slice(0, 300);

const argText = (a: any): string =>
    a?.value !== undefined ? String(a.value) : (a?.description ?? a?.unserializableValue ?? a?.type ?? "");

export async function watchConsole(
    session: CdpSession,
    seconds: number,
    opts: { levels?: ReadonlySet<string> } = {},
): Promise<{ total: number; templates: ConsoleTemplate[] }> {
    const levels = opts.levels ?? new Set(["error", "warning", "assert"]);
    const workerSid = await attachEmulatorWorker(session).catch(() => null);
    const seen = new Map<string, ConsoleTemplate>();
    let total = 0;
    const note = (realm: "page" | "worker", level: string, text: string, where: string): void => {
        total++;
        const template = templateOf(text);
        const key = `${realm}|${level}|${template}`;
        const hit = seen.get(key);
        if (hit) hit.count++;
        else seen.set(key, { realm, level, count: 1, template, sample: text.slice(0, 600), where });
    };
    const realmOf = (sid?: string): "page" | "worker" => (workerSid && sid === workerSid ? "worker" : "page");
    const frameOf = (st: any): string => {
        const f = st?.callFrames?.[0];
        return f ? `${f.functionName || "<anon>"} ${String(f.url).split("/").pop()}:${f.lineNumber + 1}` : "";
    };
    const onConsole = (p: any, sid?: string): void => {
        if (!levels.has(p.type)) return;
        note(realmOf(sid), p.type, (p.args ?? []).map(argText).join(" "), frameOf(p.stackTrace));
    };
    const onException = (p: any, sid?: string): void => {
        const d = p.exceptionDetails ?? {};
        note(realmOf(sid), "exception", d.exception?.description ?? d.text ?? "exception", frameOf(d.stackTrace));
    };
    session.on("Runtime.consoleAPICalled", onConsole);
    session.on("Runtime.exceptionThrown", onException);
    try {
        await session.send("Runtime.enable", {});
        if (workerSid) await session.send("Runtime.enable", {}, workerSid);
        await new Promise((r) => setTimeout(r, seconds * 1000));
    } finally {
        session.off("Runtime.consoleAPICalled", onConsole);
        session.off("Runtime.exceptionThrown", onException);
    }
    return { total, templates: [...seen.values()].sort((a, b) => b.count - a.count) };
}
