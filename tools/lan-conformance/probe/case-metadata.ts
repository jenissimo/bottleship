export type RoleMode = "native" | "emu";
export type RunMode = "record" | "check" | "run";

export function parseArgs(argv: string[]) {
    const rest: string[] = [];
    let force = false, wireHost = false;
    let roleModes: Record<string, RoleMode> | undefined;
    for (const arg of argv) {
        if (arg === "--force") force = true;
        else if (arg === "--wire-host") wireHost = true;
        else if (arg.startsWith("--as=")) {
            roleModes = {};
            for (const pair of arg.slice(5).split(",")) {
                const [role, mode, extra] = pair.split("=");
                if (!/^[a-z0-9]+$/.test(role ?? "") || (mode !== "native" && mode !== "emu") || extra !== undefined) {
                    throw new Error("Bad --as entry: " + pair);
                }
                roleModes[role] = mode;
            }
        } else if (arg.startsWith("--")) throw new Error("Unknown option: " + arg);
        else rest.push(arg);
    }
    return { rest, force, roleModes, wireHost };
}

export function scriptMetadata(text: string) {
    const gates = new Set<string>(), signals = new Set<string>(), published = new Set<string>(), required = new Set<string>();
    const skip = /^\s*# emu-skip (.+)$/m.exec(text)?.[1].trim() ?? null;
    const add = (set: Set<string>, value?: string) => { if (value && /^[a-z0-9-]+$/.test(value)) set.add(value); };
    for (const line of text.split(/\r?\n/)) {
        let words = line.trim().split(/\s+/);
        if (words[1] === "=") words = words.slice(2);
        switch (words[0]) {
            case "gate": add(gates, words[1]); break;
            case "signal": add(signals, words[1]); break;
            case "publishaddr": add(published, words[2]); break;
            case "publishlocal": case "publiship": add(published, words[1]); break;
            case "waitaddr": add(required, words[1]); break;
        }
    }
    return { gates: [...gates], signals: [...signals], published: [...published], required: [...required], skip };
}

export function planRoles(roles: string[], mode: RunMode, roleModes?: Record<string, RoleMode>, wireHost = false) {
    if (!roles.length) throw new Error("No role scripts");
    if (wireHost && !roles.includes("host")) throw new Error("--wire-host requires a host role");
    if (wireHost && mode === "record") throw new Error("Record goldens with native roles; use run --wire-host for diagnostics");
    for (const role of Object.keys(roleModes ?? {})) {
        if (!roles.includes(role) || (wireHost && role === "host")) throw new Error("Inactive or unknown role: " + role);
    }
    return roles.filter(role => !wireHost || role !== "host").map(role => ({
        role, mode: mode === "record" ? "native" as const : roleModes?.[role] ?? "emu",
    }));
}

export function checkSkip(scripts: Array<{ text: string; mode: RoleMode }>) {
    for (const script of scripts) if (script.mode === "emu") {
        const reason = scriptMetadata(script.text).skip;
        if (reason) return reason;
    }
    return null;
}
