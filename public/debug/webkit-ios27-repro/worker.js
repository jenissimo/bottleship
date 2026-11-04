import { createRepro } from "./repro-core.js";

const post = (m) => self.postMessage(m);

self.onmessage = async (ev) => {
    if (ev.data?.type !== "start") return;
    let r;
    try {
        r = await createRepro(ev.data.opts, (m) => post(m));
    } catch (e) {
        post({ kind: "error", text: "setup: " + (e && e.stack || e) });
        return;
    }
    post({ kind: "info", text: `started: memory ${r.memoryMB()} MB, opts ${JSON.stringify(r.opts)}` });
    const t0 = performance.now();
    let lastReport = 0;

    // Same-thread MessageChannel tick loop: every tick is a MessagePort event, as in v86.
    const ch = new MessageChannel();
    ch.port2.onmessage = () => {
        try {
            r.tick();
        } catch (e) {
            r.st.error = String(e && e.stack || e);
            post({ kind: "error", text: "tick threw: " + r.st.error, st: r.st });
            return;
        }
        const now = performance.now();
        if (now - lastReport > 250) {
            lastReport = now;
            post({ kind: "status", st: r.st, memMB: r.memoryMB(), live: r.liveCount(), sec: ((now - t0) / 1000).toFixed(1) });
        }
        if (r.opts.seconds && now - t0 > r.opts.seconds * 1000) {
            post({ kind: "done", st: r.st, memMB: r.memoryMB() });
            return;
        }
        ch.port1.postMessage(0);
    };
    ch.port1.postMessage(0);
};
