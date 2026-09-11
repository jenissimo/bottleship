/**
 * `.reg` files ("Windows Registry Editor Version 5.00") → the bundle's registry seed array.
 *
 * A game drop that came through an installer or a Wine prefix ships its registry as `.reg`
 * text, and that text is the authoritative record of what the installer wrote — retyping it
 * into JSON by hand is exactly the backslash-escaping trap `make-wgb` exists to avoid.
 *
 * The seed format is our own (`RegistrySeed`), so this parser reduces `.reg` to it and
 * refuses anything it cannot represent by name rather than dropping it silently.
 */

export class RegError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegError";
    }
}

export type RegSeedValueType = "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";

export interface RegSeedValue {
    name: string;
    type: RegSeedValueType;
    data: string | number;
}

export interface RegSeed {
    root: string;
    path: string;
    values: RegSeedValue[];
}

export interface ParseRegOptions {
    /**
     * Fold a WOW6432Node segment out of the path. Our guest is 32-bit, so a 64-bit host's
     * `SOFTWARE\WOW6432Node\EA GAMES` is the very key the game reads as `SOFTWARE\EA GAMES`;
     * leaving the node in place seeds a key nothing ever looks at.
     */
    foldWow6432Node?: boolean;
    /** Names of unsupported constructs found while parsing (reported, never silently dropped). */
    onSkip?: (reason: string) => void;
}

const ROOT_ALIASES: Record<string, string> = {
    HKEY_LOCAL_MACHINE: "HKLM",
    HKLM: "HKLM",
    HKEY_CURRENT_USER: "HKCU",
    HKCU: "HKCU",
    HKEY_CLASSES_ROOT: "HKCR",
    HKCR: "HKCR",
    HKEY_USERS: "HKU",
    HKU: "HKU",
    HKEY_CURRENT_CONFIG: "HKCC",
    HKCC: "HKCC",
};

/** Decode as UTF-16LE when the BOM says so — regedit 5.00 writes UTF-16, Wine writes UTF-8. */
export function decodeRegText(bytes: Uint8Array): string {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder("utf-8").decode(bytes.subarray(start));
}

/** Unescape a quoted .reg string: `\\` → `\`, `\"` → `"`. */
function unquote(raw: string): string {
    const body = raw.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\" && i + 1 < body.length) {
            i++;
            out += body[i];
        } else {
            out += body[i];
        }
    }
    return out;
}

function parseHexList(spec: string): number[] {
    const bytes: number[] = [];
    for (const token of spec.split(",")) {
        const t = token.trim();
        if (t === "") continue;
        const v = parseInt(t, 16);
        if (!Number.isFinite(v)) throw new RegError(`bad hex byte "${t}"`);
        bytes.push(v & 0xff);
    }
    return bytes;
}

/**
 * hex(7) is a REG_MULTI_SZ carried as UTF-16LE. Our store keeps REG_MULTI_SZ as a hex byte
 * blob handed back verbatim to both the A and W registry APIs, and A callers are the
 * majority — so the strings are re-encoded 8-bit, NUL-separated, double-NUL terminated.
 */
function multiSzHex(bytes: number[]): string {
    const parts = new TextDecoder("utf-16le")
        .decode(new Uint8Array(bytes))
        .split("\0")
        .filter((s) => s !== "");
    const out: number[] = [];
    for (const part of parts) {
        for (const ch of part) out.push(ch.charCodeAt(0) & 0xff);
        out.push(0);
    }
    out.push(0);
    return toHex(out);
}

function toHex(bytes: number[]): string {
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseRegFile(bytes: Uint8Array, opts: ParseRegOptions = {}): RegSeed[] {
    const text = decodeRegText(bytes);
    const first = text.split(/\r?\n/, 1)[0] ?? "";
    if (!/^﻿?Windows Registry Editor Version 5\.00|^REGEDIT4/.test(first.trim())) {
        throw new RegError(`not a .reg file (header line was ${JSON.stringify(first.slice(0, 40))})`);
    }

    // A value may continue across lines with a trailing backslash (long hex blobs).
    const lines: string[] = [];
    for (const raw of text.split(/\r?\n/).slice(1)) {
        const line = raw.replace(/﻿/g, "");
        if (lines.length > 0 && /\\\s*$/.test(lines[lines.length - 1]!)) {
            lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\\\s*$/, "") + line.trim();
            continue;
        }
        lines.push(line);
    }

    const seeds: RegSeed[] = [];
    let current: RegSeed | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith(";")) continue;

        if (trimmed.startsWith("[")) {
            if (trimmed.startsWith("[-")) {
                opts.onSkip?.(`key deletion ${trimmed} (a seed cannot express a delete)`);
                current = null;
                continue;
            }
            const inner = trimmed.slice(1, trimmed.lastIndexOf("]"));
            const sep = inner.indexOf("\\");
            const rootRaw = (sep < 0 ? inner : inner.slice(0, sep)).toUpperCase();
            const root = ROOT_ALIASES[rootRaw];
            if (!root) throw new RegError(`unknown registry root "${rootRaw}"`);
            let path = sep < 0 ? "" : inner.slice(sep + 1);
            if (opts.foldWow6432Node) path = path.replace(/(^|\\)WOW6432Node\\/i, "$1");
            current = { root, path, values: [] };
            seeds.push(current);
            continue;
        }

        if (!current) {
            opts.onSkip?.(`value outside any key: ${trimmed}`);
            continue;
        }

        const eq = splitNameAndData(trimmed);
        if (!eq) {
            opts.onSkip?.(`unparsed line: ${trimmed}`);
            continue;
        }
        const [nameSpec, dataSpec] = eq;
        // "@" is the key's default value; our store keys values by name, and "" is that name.
        const name = nameSpec === "@" ? "" : unquote(nameSpec);
        const value = parseValue(name, dataSpec, opts);
        if (value) current.values.push(value);
    }
    return seeds;
}

/** Split `"name"=data` / `@=data` at the `=` that is not inside the quoted name. */
function splitNameAndData(line: string): [string, string] | null {
    if (line.startsWith("@")) {
        const eq = line.indexOf("=");
        return eq < 0 ? null : ["@", line.slice(eq + 1).trim()];
    }
    if (!line.startsWith('"')) return null;
    for (let i = 1; i < line.length; i++) {
        if (line[i] === "\\") {
            i++;
            continue;
        }
        if (line[i] === '"') {
            const eq = line.indexOf("=", i);
            return eq < 0 ? null : [line.slice(0, i + 1), line.slice(eq + 1).trim()];
        }
    }
    return null;
}

function parseValue(name: string, spec: string, opts: ParseRegOptions): RegSeedValue | null {
    if (spec.startsWith('"')) return { name, type: "REG_SZ", data: unquote(spec) };
    if (spec === "-") {
        opts.onSkip?.(`value deletion for "${name}"`);
        return null;
    }
    const dword = /^dword:\s*([0-9a-fA-F]+)$/.exec(spec);
    if (dword) return { name, type: "REG_DWORD", data: parseInt(dword[1]!, 16) >>> 0 };

    const hex = /^hex(?:\(([0-9a-fA-F]+)\))?:\s*(.*)$/.exec(spec);
    if (hex) {
        const kind = hex[1] ? parseInt(hex[1], 16) : 3; // bare `hex:` is REG_BINARY
        const bytes = parseHexList(hex[2] ?? "");
        switch (kind) {
            case 1: // REG_SZ stored as hex (UTF-16LE)
            case 2: // REG_EXPAND_SZ — we have no expansion, so keep the literal text
                return {
                    name,
                    type: "REG_SZ",
                    data: new TextDecoder("utf-16le").decode(new Uint8Array(bytes)).replace(/\0+$/, ""),
                };
            case 3:
                return { name, type: "REG_BINARY", data: toHex(bytes) };
            case 4:
                return {
                    name,
                    type: "REG_DWORD",
                    data: ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) >>> 0,
                };
            case 7:
                return { name, type: "REG_MULTI_SZ", data: multiSzHex(bytes) };
            default:
                opts.onSkip?.(`value "${name}": unsupported hex type ${kind}`);
                return null;
        }
    }
    opts.onSkip?.(`value "${name}": unrecognised data "${spec.slice(0, 40)}"`);
    return null;
}

/** Merge seeds that name the same key, so one key is seeded once. */
export function mergeRegSeeds(seeds: RegSeed[]): RegSeed[] {
    const byKey = new Map<string, RegSeed>();
    for (const seed of seeds) {
        const key = `${seed.root}\\${seed.path}`.toLowerCase();
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { ...seed, values: [...seed.values] });
            continue;
        }
        for (const v of seed.values) {
            const at = existing.values.findIndex((e) => e.name.toLowerCase() === v.name.toLowerCase());
            if (at >= 0) existing.values[at] = v;
            else existing.values.push(v);
        }
    }
    return [...byKey.values()];
}
