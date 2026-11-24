export type WwtMode = "fast" | "protected";

export function parseWwtMode(value: unknown): WwtMode | undefined {
    return value === "fast" || value === "protected" ? value : undefined;
}

export function resolveWwtMode(explicit: unknown, manifest: unknown, memory?: unknown,
    linkage?: unknown): WwtMode {
    return parseWwtMode(explicit)
        ?? (memory === "paged" || linkage === "page-local" ? "protected" : undefined)
        ?? parseWwtMode(manifest)
        ?? "fast";
}
