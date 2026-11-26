import type { PeAotProgress } from "../worker/wwt/pe-aot-progress";

export interface PeAotLoadingStatus {
    pending: PeAotProgress[];
    results: PeAotProgress[];
}

export function updatePeAotLoadingStatus(previous: PeAotLoadingStatus | undefined, event: PeAotProgress): PeAotLoadingStatus | undefined {
    const pending = previous?.pending ?? [];
    const results = previous?.results ?? [];
    const index = pending.findIndex(item => item.attempt === event.attempt);
    if (index === -1 && event.phase !== "lookup") return previous;
    if (event.phase === "ready" || event.phase === "fallback") {
        return { pending: pending.filter(item => item.attempt !== event.attempt), results: [...results, event] };
    }
    const next = [...pending];
    next[index === -1 ? next.length : index] = event;
    return { pending: next, results };
}

export function peAotStageLabel(event: PeAotProgress): string {
    switch (event.phase) {
        case "lookup": return "Checking cache";
        case "starting": return "Starting compiler";
        case "compiling": return event.work ? {
            discover: "Decoding code",
            lift: "Translating functions",
            optimize: "Optimizing functions",
            emit: "Generating WebAssembly",
        }[event.work.stage] : "Translating to WebAssembly";
        case "output": return "Preparing compiled output";
        case "finalizing": return event.source === "cache" ? "Cache hit, installing" : "Installing compiled module";
        case "ready": return event.source === "cache" ? "Ready from cache" : "Compilation ready";
        case "fallback": {
            if (event.reason === "timeout") return `Timed out after ${event.budgetMs / 1000}s, using demand translation`;
            const reason = {
                "error": "Compilation failed",
                "ineligible": "Module is ineligible",
                "image-changed": "Module or runtime state changed",
            }[event.reason];
            return `${reason}, using demand translation`;
        }
    }
}
