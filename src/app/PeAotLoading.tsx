import { useEffect, useState } from "react";
import { peAotStageLabel, type PeAotLoadingStatus } from "./pe-aot-loading";
import type { PeAotProgress, PeAotWork } from "../worker/wwt/pe-aot-progress";
import s from "./App.module.css";

function elapsedSeconds(startedAt: number) {
  return Math.max(0, Math.floor((performance.timeOrigin + performance.now() - startedAt) / 1000));
}

function TranslationElapsed({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt));

  useEffect(() => {
    const update = () => setSeconds(elapsedSeconds(startedAt));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return <span aria-hidden="true" className={s["loading-overlay__aot-elapsed"]}> · {seconds}s elapsed</span>;
}

function WorkCounter({ work }: { work: PeAotWork }) {
  const count = work.completed.toLocaleString();
  const amount = work.total === undefined ? count : `${count} / ${work.total.toLocaleString()}`;
  return <span aria-live="off" className={s["loading-overlay__aot-elapsed"]}> · {amount} {work.stage === "discover" ? "instructions" : "functions"}</span>;
}

function ModuleStatus({ event }: { event: PeAotProgress }) {
  return (
    <div className={s["loading-overlay__aot-module"]}>
      <strong>{event.module}</strong>
      <span>
        {peAotStageLabel(event)}
        {event.phase === "compiling" && event.work && <WorkCounter work={event.work} />}
        {event.phase === "compiling" && <TranslationElapsed startedAt={event.startedAt} />}
      </span>
    </div>
  );
}

export function PeAotLoading({ pending, results }: PeAotLoadingStatus) {
  const latest = results.at(-1);
  const earlier = results.slice(0, -1).reverse();
  return (
    <section className={s["loading-overlay__aot"]} aria-label="AOT compilation">
      <div className={s["loading-overlay__aot-heading"]}>AOT compilation</div>
      <div className={s["loading-overlay__aot-status"]} role="status">
        {pending.map(event => (
          <div className={s["loading-overlay__aot-active"]} key={event.attempt}>
            <ModuleStatus event={event} />
            <div
              className={`${s["loading-overlay__bar-wrap"]} ${s["is-indeterminate"]}`}
              role="progressbar"
              aria-label={`${event.module} · ${peAotStageLabel(event)}`}
            >
              <div className={s["loading-overlay__bar"]} />
            </div>
          </div>
        ))}
        {latest && <ModuleStatus event={latest} />}
      </div>
      {earlier.length > 0 && (
        <details className={s["loading-overlay__aot-history"]}>
          <summary>Earlier results ({earlier.length})</summary>
          <ul>
            {earlier.map(event => <li key={event.attempt}><ModuleStatus event={event} /></li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
