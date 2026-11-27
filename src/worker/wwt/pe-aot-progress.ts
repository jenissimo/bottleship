export type PeAotSource = "cache" | "compiler";

export interface PeAotWork {
    stage: "discover" | "lift" | "optimize" | "emit";
    completed: number;
    total?: number;
}

export type PeAotStatus =
    | { phase: "lookup" | "starting" | "output" }
    | { phase: "compiling"; startedAt: number; work?: PeAotWork }
    | { phase: "finalizing" | "ready"; source: PeAotSource }
    | { phase: "fallback"; reason: "timeout"; budgetMs: number }
    | { phase: "fallback"; reason: "ineligible" | "image-changed" | "error" };

export type PeAotProgress = PeAotStatus & {
    type: "pe_aot_progress";
    launchId: number;
    attempt: number;
    module: string;
};
