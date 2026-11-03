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
 * strings resolved through the string table. Matching-file attributes are not evaluated —
 * a database the game ships names the game's own files.
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
        const [entry] = children(view, item, stringTable.data + stringTable.size);
        if (!entry || entry.offset !== item) throw new SdbError(`dangling string reference at ${t.offset}`);
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

function unescapeSpaces(spec: string): string {
    return spec.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The key redirects the exes' VirtualRegistry shims declare, once each however many exes share
 * them. Anything else a VirtualRegistry command line asks for, and every other shim, is reported
 * through `onSkip` rather than dropped silently.
 */
export function virtualRegistryRedirects(exes: SdbExe[], onSkip?: (reason: string) => void): RegistryRedirect[] {
    const seen = new Set<string>();
    const rules: RegistryRedirect[] = [];
    for (const exe of exes) {
        for (const shim of exe.shims) {
            if (shim.name.toLowerCase() !== "virtualregistry") {
                onSkip?.(`${exe.name}: shim ${shim.name} is not supported`);
                continue;
            }
            // Commands are space-separated, so spaces inside a key are written as %20.
            for (const command of (shim.commandLine ?? "").split(/\s+/).filter(Boolean)) {
                const m = /^ADDREDIRECT\(([^^()]+)\^([^^()]+)\)$/i.exec(command);
                if (!m) {
                    onSkip?.(`${exe.name}: VirtualRegistry command ${command} is not supported`);
                    continue;
                }
                const rule = { from: unescapeSpaces(m[1]!), to: unescapeSpaces(m[2]!) };
                const id = `${rule.from}\n${rule.to}`.toLowerCase();
                if (seen.has(id)) continue;
                seen.add(id);
                rules.push(rule);
            }
        }
    }
    return rules;
}
