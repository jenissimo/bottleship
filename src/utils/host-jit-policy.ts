// Whether v86 may compile guest code to WebAssembly on this host.
//
// iOS/iPadOS WebKit 27 kills the WebContent process (EXC_ARM_PAC_FAIL inside JSC's in-place
// interpreter tail-call path) a few seconds into a boot with the JIT on; macOS Safari 27 and
// iOS 26 run the same build. The trigger is the cross-module return_call_indirect of RET
// chaining: with only that off (`notail`) an iPhone on iOS 27.2 ran the Hitman demo for
// minutes at ~69 MIPS, against ~37 MIPS with no compilation at all, so `notail` is the
// iOS 27 default. Every iOS browser is WebKit, so the gate is the platform, not
// the browser. The decision needs navigator.maxTouchPoints (iPadOS reports a Mac UA), which
// WorkerNavigator does not expose, so the page resolves it and hands the mode to the worker.
//
// `?jit=` on the page URL overrides the gate for on-device experiments:
//   1 | on     JIT on (shipping configuration)
//   0 | off    no compilation at all
//   notail     JIT on, but no module contains return_call_indirect (RET chaining off;
//              block chaining is already off in shipping)

export type HostJitMode = "on" | "off" | "notail";

export interface HostJitPolicy {
    mode: HostJitMode;
    reason: "default" | "query" | "ios-webkit-27";
}

export interface HostJitSignals {
    userAgent: string;
    maxTouchPoints: number;
    /** location.search of the page that owns the emulator worker. */
    search: string;
}

/** First WebKit major on iOS/iPadOS known to crash with the JIT on. */
export const IOS_WEBKIT_JIT_BROKEN_MAJOR = 27;

const QUERY_MODES: Record<string, HostJitMode> = {
    "1": "on", on: "on", "0": "off", off: "off", notail: "notail",
};

export function isHostJitMode(value: unknown): value is HostJitMode {
    return value === "on" || value === "off" || value === "notail";
}

function isAppleMobileWebKit(ua: string, maxTouchPoints: number): boolean {
    if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
    // iPadOS "desktop" UA. No Mac has a touchscreen, so touch points are the tell.
    return /\bMacintosh\b/.test(ua) && /AppleWebKit\//.test(ua) && maxTouchPoints > 1;
}

/**
 * The iOS major the UA describes, or null when it cannot be known. Safari's `Version/NN`
 * tracks the OS major. The `OS NN_N` token was frozen at 18_6 from iOS 26 on, so 18_6 with
 * no Version token (a third-party iOS browser) is ambiguous; anything else in it is real.
 */
function appleMobileMajor(ua: string): number | null {
    const version = /\bVersion\/(\d+)/.exec(ua);
    if (version) return Number(version[1]);
    const os = /\bOS (\d+)_(\d+)/.exec(ua);
    if (!os) return null;
    if (os[1] === "18" && os[2] === "6") return null;
    return Number(os[1]);
}

export function resolveHostJitPolicy(signals: HostJitSignals): HostJitPolicy {
    const requested = new URLSearchParams(signals.search).get("jit");
    const forced = requested === null ? undefined : QUERY_MODES[requested.toLowerCase()];
    if (forced) return { mode: forced, reason: "query" };

    if (isAppleMobileWebKit(signals.userAgent, signals.maxTouchPoints)) {
        const major = appleMobileMajor(signals.userAgent);
        // Unknown means a frozen token on iOS 26 or later; notail is safe on 26 as well.
        if (major === null || major >= IOS_WEBKIT_JIT_BROKEN_MAJOR) {
            return { mode: "notail", reason: "ios-webkit-27" };
        }
    }
    return { mode: "on", reason: "default" };
}

interface JitConfigExports {
    set_jit_config?: (index: number, value: number) => number;
}

/**
 * Apply the mode to a freshly initialised v86, after PreemptionManager has applied the
 * shipping slots (which this deliberately leaves untouched). Returns the slots it wrote.
 */
export function applyHostJitMode(ex: JitConfigExports | undefined, mode: HostJitMode): Array<[number, number]> {
    const writes: Array<[number, number]> =
        mode === "off" ? [[0, 1]] : mode === "notail" ? [[4, 0], [12, 0]] : [];
    if (typeof ex?.set_jit_config !== "function") return [];
    for (const [index, value] of writes) {
        const status = ex.set_jit_config(index, value) >>> 0;
        if (status !== 0) throw new Error(`set_jit_config(${index}, ${value}) failed with status ${status}`);
    }
    return writes;
}
