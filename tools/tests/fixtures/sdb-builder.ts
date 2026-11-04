/**
 * A synthetic shim database laid out the way sdbinst-era tools write one: an index list first,
 * then the DATABASE, then the string table every STRINGREF points into.
 */
export interface SdbFixtureExe {
    name: string;
    shims: Array<{ name: string; cmd?: string }>;
}

export interface SdbFixtureOptions {
    /** Store string fields inline (STRING tags) instead of as STRINGREFs. */
    inlineNames?: boolean;
    /** Make the STRINGREF of this string point at a tag in the table that is not a STRINGTABLE_ITEM. */
    strayRefFor?: string;
}

export function buildSdb(exes: SdbFixtureExe[], opts: SdbFixtureOptions = {}): Uint8Array {
    const word = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const dword = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    const utf16z = (s: string) => [...s].flatMap((c) => word(c.charCodeAt(0))).concat([0, 0]);
    const list = (tag: number, body: number[]) => [...word(tag), ...dword(body.length), ...body];

    const items: number[][] = [];
    const tableOffsets = new Map<string, number>();
    let tableCursor = 6; // past the STRINGTABLE tag + size
    // A DWORD tag sitting in the string table: a valid tag, but not a STRINGTABLE_ITEM.
    const strayOffset = tableCursor;
    if (opts.strayRefFor !== undefined) {
        const stray = [...word(0x4001), ...dword(0)];
        items.push(stray);
        tableCursor += stray.length;
    }
    const ref = (s: string): number => {
        if (s === opts.strayRefFor) return strayOffset;
        let off = tableOffsets.get(s);
        if (off === undefined) {
            off = tableCursor;
            tableOffsets.set(s, off);
            const item = [...word(0x8801), ...dword((s.length + 1) * 2), ...utf16z(s)];
            items.push(item);
            tableCursor += item.length;
        }
        return off;
    };
    const strField = (tag: number, s: string) => opts.inlineNames
        ? [...word((tag & 0x0fff) | 0x8000), ...dword((s.length + 1) * 2), ...utf16z(s)]
        : [...word(tag), ...dword(ref(s))];

    const exeLists = exes.flatMap((exe) => list(0x7007, [
        ...strField(0x6001, exe.name),
        ...list(0x7008, [...strField(0x6001, "*")]),
        ...exe.shims.flatMap((shim) => list(0x7009, [
            ...strField(0x6001, shim.name),
            ...(shim.cmd !== undefined ? strField(0x6008, shim.cmd) : []),
        ])),
    ]));
    const database = list(0x7001, [...word(0x4023), ...dword(4), ...strField(0x6001, "Test Compatibility Database"), ...exeLists]);
    const indexes = list(0x7802, list(0x7803, [...word(0x3802), ...word(0x7007), ...list(0x9801, [])]));
    const table = list(0x7801, items.flat());
    return new Uint8Array([...dword(2), ...dword(3), ..."sdbf"].map((c) => typeof c === "string" ? c.charCodeAt(0) : c).concat(indexes, database, table));
}
