// One-shot note when the worker measured the guest running far below what this host should
// deliver (execution-health.ts). Shown in the host UI, never in the guest picture; the worker
// fires it at most once per session, and it retires itself if left alone.

import React, { useEffect } from "react";
import { Button } from "../ui";
import s from "./SlowExecutionHint.module.css";
import { perfHintText, type PerfHint } from "./perf-hint-text";

export type { PerfHint };

const AUTO_DISMISS_MS = 30_000;

export interface SlowExecutionHintProps {
    hint: PerfHint;
    statsOverlayOn: boolean;
    onShowStats: () => void;
    onDismiss: () => void;
}

export const SlowExecutionHint: React.FC<SlowExecutionHintProps> = ({ hint, statsOverlayOn, onShowStats, onDismiss }) => {
    useEffect(() => {
        const t = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
        return () => window.clearTimeout(t);
    }, [onDismiss]);

    const { title, body } = perfHintText(hint);
    return (
        <div className={s["hint"]} role="status" data-touch-reserved="" onPointerDown={(e) => e.stopPropagation()}>
            <div className={s["hint__title"]}>{title}</div>
            <p className={s["hint__body"]}>{body}</p>
            <div className={s["hint__actions"]}>
                {!statsOverlayOn && (
                    <Button onClick={() => { onShowStats(); onDismiss(); }}>Show stats overlay</Button>
                )}
                <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
            </div>
        </div>
    );
};
