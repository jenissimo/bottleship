/**
 * Shim databases (`.sdb`, "sdbf") → the shims a game asks Windows to apply to its own exes.
 *
 * Some store re-releases do not patch an old binary; they ship a compatibility database and
 * register it with `sdbinst` at install time. Steam's Mafia is one: its Setup.exe writes the
 * settings under HKLM, its Game.exe reads them from HKCU, and a VirtualRegistry shim in
 * `mafia.sdb` redirects the one onto the other. Windows applies that silently; without it the
 * game relaunches Setup forever.
 *
 * Only the part of the format that names shims is read: DATABASE → EXE → SHIM_REF, with
 * strings resolved through the string table. Matching-file attributes are not evaluated: an
 * entry is matched to a process by its EXE NAME alone (see `redirectsForImage`), and an entry
 * whose NAME is a wildcard — one that only MATCHING_FILE attributes could identify — is
 * skipped and reported.
 */

export class SdbError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SdbError";
    }
}

export interface SdbShimRef {
    name: string;
    commandLine?: string;
}

export interface SdbExe {
    /** File name the entry matches (e.g. "Game.exe"). */
    name: string;
    shims: SdbShimRef[];
}

export interface RegistryRedirect {
    /** Key the guest names, "HKLM\SOFTWARE\Vendor\Game". */
    from: string;
    /** Key it lands in instead. */
    to: string;
}

/**
 * A redirect bound to the exe whose database entry declares it. Windows decides per process,
 * at its start, which entry matches the image; only that process's registry calls are
 * redirected, and a child process is matched on its own.
 */
export interface ExeRegistryRedirect extends RegistryRedirect {
    /** File name of the image the rule applies to ("Game.exe"), compared case-insensitively. */
    exe: string;
}

const TAG_TYPE_MASK = 0xf000;
const TYPE_NULL = 0x1000;
const TYPE_BYTE = 0x2000;
const TYPE_WORD = 0x3000;
const TYPE_DWORD = 0x4000;
const TYPE_QWORD = 0x5000;
const TYPE_STRINGREF = 0x6000;
const TYPE_STRING = 0x8000;

const TAG_DATABASE = 0x7001;
const TAG_EXE = 0x7007;
const TAG_SHIM_REF = 0x7009;
const TAG_STRINGTABLE = 0x7801;
const TAG_STRINGTABLE_ITEM = 0x8801;
const TAG_NAME = 0x6001;
const TAG_COMMAND_LINE = 0x6008;

const HEADER_SIZE = 12;

interface Tag {
    tag: number;
    /** Offset of the tag word. */
    offset: number;
    /** Offset of the payload (past the size field for LIST/STRING/BINARY). */
    data: number;
    size: number;
}

function* children(view: DataView, start: number, end: number): Generator<Tag> {
    let off = start;
    while (off + 2 <= end) {
        const tag = view.getUint16(off, true);
        let data = off + 2;
        let size: number;
        switch (tag & TAG_TYPE_MASK) {
            case TYPE_NULL: size = 0; break;
            case TYPE_BYTE: size = 1; break;
            case TYPE_WORD: size = 2; break;
            case TYPE_DWORD:
            case TYPE_STRINGREF: size = 4; break;
            case TYPE_QWORD: size = 8; break;
            default:
                if (off + 6 > end) throw new SdbError(`truncated tag 0x${tag.toString(16)} at ${off}`);
                size = view.getUint32(off + 2, true);
                data = off + 6;
        }
        if (data + size > end) throw new SdbError(`tag 0x${tag.toString(16)} at ${off} overruns its list`);
        yield { tag, offset: off, data, size };
        off = data + size;
        // Tags are WORD-aligned; a BYTE payload or an odd-sized blob is padded.
        if (off & 1) off++;
    }
}

export function parseSdb(bytes: Uint8Array): SdbExe[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < HEADER_SIZE || new TextDecoder("ascii").decode(bytes.subarray(8, 12)) !== "sdbf") {
        throw new SdbError("not a shim database (missing \"sdbf\" magic)");
    }
    const top = [...children(view, HEADER_SIZE, bytes.length)];
    const stringTable = top.find((t) => t.tag === TAG_STRINGTABLE);
    const database = top.find((t) => t.tag === TAG_DATABASE);
    if (!database) throw new SdbError("no DATABASE list");

    const utf16 = new TextDecoder("utf-16le");
    const inline = (t: Tag) => utf16.decode(bytes.subarray(t.data, t.data + t.size)).replace(/\0+$/, "");
    const str = (t: Tag): string => {
        if ((t.tag & TAG_TYPE_MASK) === TYPE_STRING) return inline(t);
        // A STRINGREF is the offset of a STRINGTABLE_ITEM, counted from the STRINGTABLE tag.
        if (!stringTable) throw new SdbError("string reference without a string table");
        const item = stringTable.offset + view.getUint32(t.data, true);
        const end = stringTable.data + stringTable.size;
        if (item < stringTable.data || item + 6 > end) {
            throw new SdbError(`string reference at ${t.offset} points outside the string table`);
        }
        const [entry] = children(view, item, end);
        if (!entry || entry.tag !== TAG_STRINGTABLE_ITEM) {
            throw new SdbError(`string reference at ${t.offset} does not point at a STRINGTABLE_ITEM`);
        }
        return inline(entry);
    };
    // A string field is stored either as a STRINGREF (the usual form) or inline as a STRING.
    const field = (list: Tag, id: number): string | undefined => {
        const inlineId = (id & 0x0fff) | TYPE_STRING;
        for (const t of children(view, list.data, list.data + list.size)) {
            if (t.tag === id || t.tag === inlineId) return str(t);
        }
        return undefined;
    };

    const exes: SdbExe[] = [];
    for (const exe of children(view, database.data, database.data + database.size)) {
        if (exe.tag !== TAG_EXE) continue;
        const name = field(exe, TAG_NAME);
        if (!name) continue;
        const shims: SdbShimRef[] = [];
        for (const ref of children(view, exe.data, exe.data + exe.size)) {
            if (ref.tag !== TAG_SHIM_REF) continue;
            const shim = field(ref, TAG_NAME);
            if (shim) shims.push({ name: shim, commandLine: field(ref, TAG_COMMAND_LINE) });
        }
        exes.push({ name, shims });
    }
    return exes;
}

/**
 * One VirtualRegistry `ADDREDIRECT(key_to_redirect_from^key_to_redirect_to)` command, as
 * Microsoft documents it ("Using the VirtualRegistry Fix", Compatibility Administrator): the two
 * keys are separated by `^`, written in the short `HKLM\Software\Vendor\Application` form, and a
 * space inside a key is coded as `%20` (commands on one command line are space-separated). Any
 * other character, parentheses included (`Program%20Files%20(x86)`), is part of the key, so the
 * argument is everything between the command's own parentheses. Only `%20` is decoded; the
 * documentation defines no other escape.
 */
function parseAddRedirect(command: string): RegistryRedirect | null {
    const m = /^ADDREDIRECT\((.*)\)$/is.exec(command);
    if (!m) return null;
    const parts = m[1]!.split("^");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const decode = (key: string) => key.replace(/%20/g, " ");
    return { from: decode(parts[0]), to: decode(parts[1]) };
}

/**
 * The key redirects each exe's VirtualRegistry shims declare, bound to that exe and once each
 * per exe. Anything else a VirtualRegistry command line asks for, every other shim, and every
 * entry that is not matched by a plain file name are reported through `onSkip` rather than
 * dropped silently.
 */
export function virtualRegistryRedirects(exes: SdbExe[], onSkip?: (reason: string) => void): ExeRegistryRedirect[] {
    const seen = new Set<string>();
    const rules: ExeRegistryRedirect[] = [];
    for (const exe of exes) {
        if (/[*?]/.test(exe.name)) {
            // Windows identifies such an entry by its MATCHING_FILE attributes, which are not read.
            onSkip?.(`${exe.name}: entry is matched by MATCHING_FILE attributes only, not by name; skipped`);
            continue;
        }
        for (const shim of exe.shims) {
            if (shim.name.toLowerCase() !== "virtualregistry") {
                onSkip?.(`${exe.name}: shim ${shim.name} is not supported`);
                continue;
            }
            for (const command of (shim.commandLine ?? "").split(/\s+/).filter(Boolean)) {
                const redirect = parseAddRedirect(command);
                if (!redirect) {
                    onSkip?.(`${exe.name}: VirtualRegistry command ${command} is not supported`);
                    continue;
                }
                const rule = { exe: exe.name, ...redirect };
                const id = `${rule.exe}\n${rule.from}\n${rule.to}`.toLowerCase();
                if (seen.has(id)) continue;
                seen.add(id);
                rules.push(rule);
            }
        }
    }
    return rules;
}

/**
 * The rules for one process: those whose exe is the image's file name. A process no entry
 * matches gets none — it sees the registry as it is.
 */
export function redirectsForImage(rules: ReadonlyArray<ExeRegistryRedirect>, imagePath: string): RegistryRedirect[] {
    const image = (imagePath.split(/[\\/]/).pop() ?? "").toLowerCase();
    if (!image) return [];
    return rules
        .filter((r) => typeof r?.exe === "string" && (r.exe.split(/[\\/]/).pop() ?? "").toLowerCase() === image)
        .map(({ from, to }) => ({ from, to }));
}

const REDIRECT_ROOTS: Record<string, string> = {
    HKCR: "hkcr", HKEY_CLASSES_ROOT: "hkcr",
    HKCU: "hkcu", HKEY_CURRENT_USER: "hkcu",
    HKLM: "hklm", HKEY_LOCAL_MACHINE: "hklm",
    HKU: "hku", HKEY_USERS: "hku",
    HKCC: "hkcc", HKEY_CURRENT_CONFIG: "hkcc",
    HKPD: "hkpd", HKEY_PERFORMANCE_DATA: "hkpd",
    HKDD: "hkdd", HKEY_DYN_DATA: "hkdd",
};

/** "HKLM\Software\X" → "hklm\software\x" (the registry's stored-key form), or why it can't be one. */
function canonicalRedirectKey(spec: unknown): { key: string } | { error: string } {
    if (typeof spec !== "string" || !spec.trim()) return { error: "empty key" };
    const clean = spec.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
    const sep = clean.indexOf("\\");
    const root = REDIRECT_ROOTS[(sep < 0 ? clean : clean.slice(0, sep)).toUpperCase()];
    if (!root) return { error: `"${spec}" does not start with a predefined root key` };
    const path = sep < 0 ? "" : clean.slice(sep + 1);
    if (!path) return { error: `"${spec}" is a whole root key` };
    if (path.split("\\").some((segment) => !segment)) return { error: `"${spec}" has an empty key name` };
    return { key: `${root}\\${path}`.toLowerCase() };
}

/** a is b, or one lies inside the other. */
function overlaps(a: string, b: string): boolean {
    return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

export interface ValidatedRedirect<R extends RegistryRedirect> {
    rule: R;
    /** Stored-key form: lowercase, short root, no edge separators. */
    from: string;
    to: string;
}

/**
 * The rules one process can apply EXACTLY once. A redirect is applied to the name the guest
 * gives; for that to be the same thing as applying it once, no key a rule produces may be one
 * another (or the same) rule would move again. So a target must not overlap any source: that
 * rejects a target inside its own source, chains (A→B, B→C) and cycles (A→B, B→A) — every rule
 * involved is rejected, not just one, since which one "wins" would be arbitrary. Also rejected:
 * a key that is not under a predefined root, a whole root ("HKLM"), and one source sent to two
 * different targets. Accepted rules come longest source first, so the most specific matches.
 */
export function validateRedirects<R extends RegistryRedirect>(rules: ReadonlyArray<R>): {
    accepted: ValidatedRedirect<R>[];
    rejected: Array<{ rule: R; reason: string }>;
} {
    const rejected: Array<{ rule: R; reason: string }> = [];
    const candidates: ValidatedRedirect<R>[] = [];
    const seen = new Set<string>();
    for (const rule of rules) {
        const from = canonicalRedirectKey(rule?.from);
        const to = canonicalRedirectKey(rule?.to);
        if ("error" in from || "error" in to) {
            rejected.push({ rule, reason: "error" in from ? `source ${from.error}` : `target ${(to as { error: string }).error}` });
            continue;
        }
        if (overlaps(from.key, to.key)) {
            rejected.push({ rule, reason: from.key === to.key
                ? "source and target are the same key"
                : "source and target lie inside one another, so the target would be redirected again" });
            continue;
        }
        const id = `${from.key}\n${to.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({ rule, from: from.key, to: to.key });
    }

    const reasons = new Map<ValidatedRedirect<R>, string>();
    for (const a of candidates) {
        for (const b of candidates) {
            if (a === b) continue;
            if (a.from === b.from && a.to !== b.to) {
                reasons.set(a, `source is also redirected to ${b.rule.to}`);
            } else if (overlaps(a.to, b.from)) {
                const cycle = overlaps(b.to, a.from);
                const reason = cycle
                    ? `forms a cycle with ${b.rule.from} -> ${b.rule.to}`
                    : `target chains into ${b.rule.from} -> ${b.rule.to}`;
                if (!reasons.has(a)) reasons.set(a, reason);
                if (!reasons.has(b)) reasons.set(b, cycle
                    ? `forms a cycle with ${a.rule.from} -> ${a.rule.to}`
                    : `source is the target of ${a.rule.from} -> ${a.rule.to}, a chain`);
            }
        }
    }
    const accepted: ValidatedRedirect<R>[] = [];
    for (const c of candidates) {
        const reason = reasons.get(c);
        if (reason) rejected.push({ rule: c.rule, reason });
        else accepted.push(c);
    }
    accepted.sort((a, b) => b.from.length - a.from.length);
    return { accepted, rejected };
}
