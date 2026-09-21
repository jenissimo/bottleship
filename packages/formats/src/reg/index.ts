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
    /**
     * Unsupported constructs found while parsing (reported, never silently dropped). `key` is
     * the key the skip happened under, so a caller importing one subtree of a whole-machine
     * hive can stay loud about its own keys without a warning storm from the rest.
     */
    onSkip?: (reason: string, key?: string) => void;
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

/**
 * The root a Wine hive's relative keys hang off, read from the file's own `;; All keys
 * relative to` line — `\Machine` is HKLM and `\User\<sid>` is that user's HKCU. Read, never
 * assumed, because seeding a game's install key under the wrong root is invisible until the
 * game reports itself uninstalled. Wine has spelled the target both bare and `REGISTRY\`-
 * prefixed over the years, so the prefix is optional here.
 */
function wineRootOf(lines: readonly string[]): string {
    for (const line of lines) {
        const m = /^;;\s*All keys relative to\s+(.+?)\s*$/.exec(line.trim());
        if (!m) continue;
        const target = m[1]!.replace(/\\\\/g, "\\").replace(/^REGISTRY\\/i, "\\");
        if (/^\\Machine$/i.test(target)) return "HKLM";
        if (/^\\User\\/i.test(target)) return "HKCU";
        throw new RegError(`Wine hive is relative to ${JSON.stringify(target)}, which maps to no registry root`);
    }
    throw new RegError("Wine hive has no `;; All keys relative to` line, so its root is unknown");
}

export function parseRegFile(bytes: Uint8Array, opts: ParseRegOptions = {}): RegSeed[] {
    const text = decodeRegText(bytes);
    const allLines = text.split(/\r?\n/);
    const first = allLines[0] ?? "";
    const wine = /^WINE REGISTRY Version \d/.test(first.replace(/﻿/g, "").trim());
    if (!wine && !/^﻿?Windows Registry Editor Version 5\.00|^REGEDIT4/.test(first.trim())) {
        throw new RegError(`not a .reg file (header line was ${JSON.stringify(first.slice(0, 40))})`);
    }
    const wineRoot = wine ? wineRootOf(allLines) : "";

    // A value may continue across lines with a trailing backslash (long hex blobs).
    const lines: string[] = [];
    for (const raw of allLines.slice(1)) {
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
        // Wine's per-file (`#arch=`) and per-key (`#time=`, `#class=`) metadata.
        if (wine && trimmed.startsWith("#")) continue;

        if (trimmed.startsWith("[")) {
            if (trimmed.startsWith("[-")) {
                opts.onSkip?.(`key deletion ${trimmed} (a seed cannot express a delete)`);
                current = null;
                continue;
            }
            const inner = trimmed.slice(1, trimmed.lastIndexOf("]"));
            let root: string;
            let path: string;
            if (wine) {
                // `[Software\\Vendor\\Game] 1700000000` — relative to the hive's own root,
                // key separators doubled, a modification timestamp after the bracket.
                root = wineRoot;
                path = inner.replace(/\\\\/g, "\\");
            } else {
                const sep = inner.indexOf("\\");
                const rootRaw = (sep < 0 ? inner : inner.slice(0, sep)).toUpperCase();
                const mapped = ROOT_ALIASES[rootRaw];
                if (!mapped) throw new RegError(`unknown registry root "${rootRaw}"`);
                root = mapped;
                path = sep < 0 ? "" : inner.slice(sep + 1);
            }
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
        const value = parseValue(name, dataSpec, opts, wine, `${current.root}\\${current.path}`);
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

/**
 * Wine's string escapes. `unquote` serves exported `.reg`, where a NUL cannot occur; a Wine
 * `str(7):` carries its REG_MULTI_SZ separators as `\0`, and decoding one as a literal "0"
 * would splice the members into a single string.
 */
function unquoteWine(raw: string): string {
    const body = raw.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\" || i + 1 >= body.length) {
            out += body[i];
            continue;
        }
        const c = body[++i]!;
        if (c === "0") out += "\0";
        else if (c === "n") out += "\n";
        else if (c === "r") out += "\r";
        else if (c === "x") {
            out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16) || 0);
            i += 4;
        } else out += c;
    }
    return out;
}

function parseValue(name: string, spec: string, opts: ParseRegOptions, wine = false, key = ""): RegSeedValue | null {
    // A Wine hive escapes a non-ASCII character as `\x2122`; unquote would keep the "x2122".
    if (spec.startsWith('"')) return { name, type: "REG_SZ", data: wine ? unquoteWine(spec) : unquote(spec) };

    // Wine's typed string form: `str(2):"%SystemRoot%\\x"`, `str(7):"a\0b\0"`.
    const str = /^str(?:\(([0-9a-fA-F]+)\))?:\s*(".*")$/.exec(spec);
    if (str) {
        const kind = str[1] ? parseInt(str[1], 16) : 1;
        const text = unquoteWine(str[2]!);
        if (kind === 1 || kind === 2) return { name, type: "REG_SZ", data: text };
        if (kind === 7) {
            const out: number[] = [];
            for (const part of text.split("\0").filter((s) => s !== "")) {
                for (const ch of part) out.push(ch.charCodeAt(0) & 0xff);
                out.push(0);
            }
            out.push(0);
            return { name, type: "REG_MULTI_SZ", data: toHex(out) };
        }
        opts.onSkip?.(`value "${name}": unsupported str type ${kind}`, key);
        return null;
    }
    if (spec === "-") {
        opts.onSkip?.(`value deletion for "${name}"`, key);
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
                opts.onSkip?.(`value "${name}": unsupported hex type ${kind}`, key);
                return null;
        }
    }
    opts.onSkip?.(`value "${name}": unrecognised data "${spec.slice(0, 40)}"`, key);
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
