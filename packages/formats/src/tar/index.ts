/**
 * tar (POSIX ustar + GNU + pax extensions) — the inner container of a `.tar.xz` game drop.
 *
 * Streaming by construction: a tar is a flat sequence of 512-byte headers and data, and the
 * xz layer above hands us arbitrary chunks, so entries are dispatched as bytes arrive and no
 * member is ever fully resident. Long names (GNU `L`/`K`, pax `path`/`linkpath`) and pax
 * `size` are honoured — truncating a 100-byte name silently is how files land in the wrong
 * directory.
 */

export class TarError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TarError";
    }
}

export type TarEntryKind = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
    readonly name: string;
    readonly size: number;
    readonly mode: number;
    readonly kind: TarEntryKind;
    /** Target for symlink/hardlink entries, else "". */
    readonly linkName: string;
    readonly mtime: number;
    /** Raw ustar typeflag, for the "other" cases a caller may want to report. */
    readonly typeFlag: string;
}

/** Where an entry's bytes go. `null` from `onEntry` skips the member's data entirely. */
export interface TarSink {
    write(chunk: Uint8Array): void;
    end(): void;
}

const BLOCK = 512;

function str(b: Uint8Array, off: number, len: number): string {
    let end = off;
    const limit = off + len;
    while (end < limit && b[end] !== 0) end++;
    return new TextDecoder("utf-8").decode(b.subarray(off, end));
}

/** Octal field; GNU base-256 (high bit set) for sizes past 8 GiB. */
function num(b: Uint8Array, off: number, len: number): number {
    if ((b[off]! & 0x80) !== 0) {
        let v = b[off]! & 0x7f;
        for (let i = 1; i < len; i++) v = v * 256 + b[off + i]!;
        return v;
    }
    const s = str(b, off, len).trim();
    if (s === "") return 0;
    const v = parseInt(s, 8);
    return Number.isFinite(v) ? v : 0;
}

function kindOf(typeFlag: string): TarEntryKind {
    switch (typeFlag) {
        case "0":
        case "\0":
        case "7":
            return "file";
        case "5":
            return "dir";
        case "2":
            return "symlink";
        case "1":
            return "hardlink";
        default:
            return "other";
    }
}

function checksumOk(h: Uint8Array): boolean {
    const stored = num(h, 148, 8);
    let signed = 0;
    let unsigned = 0;
    for (let i = 0; i < BLOCK; i++) {
        const v = i >= 148 && i < 156 ? 32 : h[i]!;
        unsigned += v;
        signed += v > 127 ? v - 256 : v;
    }
    return stored === unsigned || stored === signed;
}

/** pax extended-header records: "<len> <key>=<value>\n". */
function parsePax(data: Uint8Array): Map<string, string> {
    const out = new Map<string, string>();
    const text = new TextDecoder("utf-8").decode(data);
    let pos = 0;
    while (pos < text.length) {
        const sp = text.indexOf(" ", pos);
        if (sp < 0) break;
        const len = parseInt(text.slice(pos, sp), 10);
        if (!Number.isFinite(len) || len <= 0) break;
        const record = text.slice(sp + 1, pos + len).replace(/\n$/, "");
        const eq = record.indexOf("=");
        if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
        pos += len;
    }
    return out;
}

export interface TarHandlers {
    /** Return a sink to receive the entry's bytes, or null to skip them. */
    onEntry(entry: TarEntry): TarSink | null;
}

export class TarStream {
    private pending: Uint8Array[] = [];
    private pendingLen = 0;
    /** Bytes still owed to the current member, then its padding to a 512 boundary. */
    private dataLeft = 0;
    private padLeft = 0;
    private sink: TarSink | null = null;
    /** Set by a preceding GNU/pax header, consumed by the next real entry. */
    private overrideName: string | null = null;
    private overrideLink: string | null = null;
    private overrideSize: number | null = null;
    /** A GNU/pax metadata member whose body we buffer instead of dispatching. */
    private metaKind: "longname" | "longlink" | "pax" | null = null;
    private metaChunks: Uint8Array[] = [];
    private zeroBlocks = 0;
    private done = false;

    constructor(private readonly handlers: TarHandlers) {}

    push(chunk: Uint8Array): void {
        let offset = 0;
        while (offset < chunk.length) {
            if (this.dataLeft > 0) {
                const n = Math.min(this.dataLeft, chunk.length - offset);
                const slice = chunk.subarray(offset, offset + n);
                if (this.metaKind) this.metaChunks.push(slice.slice());
                else this.sink?.write(slice);
                this.dataLeft -= n;
                offset += n;
                if (this.dataLeft === 0) this.finishMemberBody();
                continue;
            }
            if (this.padLeft > 0) {
                const n = Math.min(this.padLeft, chunk.length - offset);
                this.padLeft -= n;
                offset += n;
                continue;
            }
            // Header territory: buffer until a whole 512-byte block is available.
            const need = BLOCK - this.pendingLen;
            const n = Math.min(need, chunk.length - offset);
            this.pending.push(chunk.subarray(offset, offset + n));
            this.pendingLen += n;
            offset += n;
            if (this.pendingLen === BLOCK) this.consumeHeader(this.takePending());
        }
    }

    /** No more input. Throws if the stream ended mid-member. */
    end(): void {
        if (this.dataLeft > 0) throw new TarError(`truncated tar: ${this.dataLeft} bytes missing from the last member`);
        this.sink?.end();
        this.sink = null;
    }

    private takePending(): Uint8Array {
        const out = new Uint8Array(BLOCK);
        let off = 0;
        for (const c of this.pending) {
            out.set(c, off);
            off += c.length;
        }
        this.pending = [];
        this.pendingLen = 0;
        return out;
    }

    private consumeHeader(h: Uint8Array): void {
        let allZero = true;
        for (let i = 0; i < BLOCK; i++) {
            if (h[i] !== 0) {
                allZero = false;
                break;
            }
        }
        if (allZero) {
            // Two zero blocks end the archive; trailing zero padding after that is normal.
            this.zeroBlocks++;
            if (this.zeroBlocks >= 2) this.done = true;
            return;
        }
        if (this.done) throw new TarError("member found after the end-of-archive marker");
        this.zeroBlocks = 0;
        if (!checksumOk(h)) throw new TarError("tar header checksum mismatch");

        const typeFlag = String.fromCharCode(h[156]!);
        const size = this.overrideSize ?? num(h, 124, 12);

        if (typeFlag === "L" || typeFlag === "K" || typeFlag === "x" || typeFlag === "g") {
            this.metaKind = typeFlag === "L" ? "longname" : typeFlag === "K" ? "longlink" : "pax";
            this.metaChunks = [];
            this.beginBody(size);
            return;
        }

        const prefix = str(h, 345, 155);
        const rawName = str(h, 0, 100);
        const name = this.overrideName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        const entry: TarEntry = {
            name,
            size,
            mode: num(h, 100, 8),
            kind: kindOf(typeFlag),
            linkName: this.overrideLink ?? str(h, 157, 100),
            mtime: num(h, 136, 12),
            typeFlag,
        };
        this.overrideName = null;
        this.overrideLink = null;
        this.overrideSize = null;

        this.sink = this.handlers.onEntry(entry);
        // Always honour the size field even for a non-file typeflag: a body we assume away
        // is a body the next header parse reads as garbage.
        this.beginBody(size);
        // A member with no body still needs its sink closed.
        if (this.dataLeft === 0) this.finishMemberBody();
    }

    private beginBody(size: number): void {
        this.dataLeft = size;
        this.padLeft = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    }

    private finishMemberBody(): void {
        if (this.metaKind) {
            const body = concat(this.metaChunks);
            this.metaChunks = [];
            if (this.metaKind === "longname") this.overrideName = str(body, 0, body.length);
            else if (this.metaKind === "longlink") this.overrideLink = str(body, 0, body.length);
            else {
                const records = parsePax(body);
                const path = records.get("path");
                const link = records.get("linkpath");
                const size = records.get("size");
                if (path !== undefined) this.overrideName = path;
                if (link !== undefined) this.overrideLink = link;
                if (size !== undefined) this.overrideSize = Number(size);
            }
            this.metaKind = null;
            return;
        }
        this.sink?.end();
        this.sink = null;
    }
}

function concat(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}
