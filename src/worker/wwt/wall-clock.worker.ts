interface ClockControl {
    buffer: SharedArrayBuffer;
    address: number;
}

// @transient(this dedicated ticker worker owns one CPU clock until disposal)
let cell: Uint32Array;
// @transient(ticker epoch replaced on each clock reset command)
let origin = 0;
// @transient(ticker interval cleared on pause and released with worker termination)
let interval: ReturnType<typeof setInterval> | undefined;

function update(): void {
    Atomics.store(cell, 0, Math.min(0xffffffff, Math.max(0, performance.now() - origin)));
}

self.onmessage = ({ data }: MessageEvent<ClockControl | "resume" | "pause" | "reset">) => {
    if (typeof data !== "string") {
        cell = new Uint32Array(data.buffer, data.address, 1);
        origin = performance.now();
        update();
        self.postMessage("ready");
        return;
    }
    if (data === "reset") {
        origin = performance.now();
        update();
        self.postMessage("ready");
    } else if (data === "resume") {
        update();
        interval ??= setInterval(update, 1);
    } else {
        clearInterval(interval);
        interval = undefined;
    }
};
export {};
