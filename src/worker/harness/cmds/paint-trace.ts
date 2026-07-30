/**
 * paintTrace — record the WM_PAINT / owner-draw delivery chain so a BLANK control or
 * an unpainted dialog names the link that dropped it instead of leaving you to guess
 * between "never posted", "filtered out by the pump", "never dispatched", "painted
 * but flushed nothing" and "chain ran with 0 tasks".
 *
 * Actions: "start" | "stop" | "read" (returns + keeps) | "clear".
 * Optional second arg: hwnds to restrict recording to (paint-family messages are
 * always recorded; a filter additionally admits every message for those windows).
 */

import type { HarnessService } from "../service";
import {
    armPaintTrace,
    readPaintTrace,
    clearPaintTrace,
    type PaintTraceEntry,
} from "../../modules/user32/paint-trace";

/** One-line rendering — the ring is read by eye far more often than by assertion. */
export function formatPaintTraceEntry(e: PaintTraceEntry): string {
    const h = e.hwnd ? ` hwnd=0x${e.hwnd.toString(16)}` : "";
    return `${e.t} ${e.ev}${h} ${e.detail}`;
}

function toHwnds(arg: unknown): number[] | undefined {
    if (!Array.isArray(arg)) return undefined;
    return arg.map((h) => Number(h) >>> 0).filter((h) => h !== 0);
}

export function registerPaintTraceCommands(svc: HarnessService): void {
    svc.register("paintTrace", (args) => {
        const action = String(args[0] ?? "read");
        const hwnds = toHwnds(args[1]);

        if (action === "start") {
            clearPaintTrace();
            armPaintTrace(true, hwnds);
            return { ok: true, started: true, hwnds: hwnds ?? null };
        }
        if (action === "stop") {
            const snapshot = readPaintTrace();
            armPaintTrace(false);
            return {
                ok: true, stopped: true, dropped: snapshot.dropped,
                lines: snapshot.entries.map(formatPaintTraceEntry),
            };
        }
        if (action === "clear") {
            clearPaintTrace();
            return { ok: true };
        }
        const snapshot = readPaintTrace();
        return {
            ok: true, active: snapshot.active, dropped: snapshot.dropped,
            count: snapshot.entries.length,
            lines: snapshot.entries.map(formatPaintTraceEntry),
        };
    });
}
