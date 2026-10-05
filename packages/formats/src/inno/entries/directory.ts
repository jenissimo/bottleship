/** setup/directory.cpp — [Dirs] entries. The installer creates these (possibly
 *  empty) directories at install time; a store-only repack loses empty ones, so
 *  bundle tooling needs the list to replicate the on-disk layout (createDirs). */

import type { BinaryReader } from "../binary-reader";
import type { ParseContext } from "../context";
import { loadConditionData, loadVersionData } from "./item";

export interface DirectoryEntry {
    name: string;
    components: string;
    tasks: string;
    languages: string;
    check: string;
}

export function loadDirectoryEntry(r: BinaryReader, ctx: ParseContext): DirectoryEntry {
    const v = ctx.version;
    const bits = v.bits();
    if (v.value < 0x01030000) r.u32();
    const name = r.encodedString(ctx.codepage);
    const condition = loadConditionData(r, ctx);
    if (v.atLeast(4, 0, 11) && v.value < 0x04010000) r.skipBinaryString();
    if (v.atLeast(2, 0, 11)) r.u32();
    loadVersionData(r, ctx);
    if (v.atLeast(4, 1, 0)) r.i16();
    if (v.atLeast(5, 2, 0)) r.storedFlags([1, 2, 4, 8, 16], bits);
    else r.storedFlags([1, 2, 4], bits);
    return {
        name,
        components: condition.components,
        tasks: condition.tasks,
        languages: condition.languages,
        check: condition.check,
    };
}
