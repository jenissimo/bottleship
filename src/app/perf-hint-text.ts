/** The worker's perf_hint payload (core/execution-health.ts PerfHintMessage), as the page keeps it. */
export interface PerfHint {
    jit: "on" | "off" | "notail" | "unknown";
    reason: "default" | "query" | "ios-webkit-27" | "runtime";
    mips: number;
}

/** Title and body for a hint, one wording per cause. */
export function perfHintText(h: PerfHint): { title: string; body: string } {
    if (h.jit === "off") {
        const why = h.reason === "query"
            ? "the page address contains ?jit=0"
            : h.reason === "runtime"
                ? "it was switched off while running (debugger or developer setting)"
                : "of the browser policy for this device";
        return {
            title: "Game is running slowly: JIT is off",
            body: `Guest code is interpreted (${h.mips} MIPS) because ${why}. Games run several times slower this way.`,
        };
    }
    return {
        title: "Game is running slowly",
        body: `Guest code runs at only ${h.mips} MIPS, well below what this browser normally reaches. `
            + "The browser may have turned off JavaScript optimization (Edge “Enhance your security on the web”, "
            + "Chrome V8 optimizer site setting), or a power-saving mode may be limiting the CPU.",
    };
}
