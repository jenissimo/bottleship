/**
 * Inno Setup header parser orchestration — ported from innoextract setup/info.cpp try_load.
 */

import { decompressBlockStream, getBlockEndOffset } from "./block-reader";
import { BinaryReader } from "./binary-reader";
import type { ParseContext } from "./context";
import { loadDataEntry, type DataEntry } from "./entries/data";
import { loadDirectoryEntry, type DirectoryEntry } from "./entries/directory";
import { loadFileEntry, type FileEntry } from "./entries/file";
import { loadIconEntry, type IconEntry } from "./entries/icon";
import { loadLanguageEntry, type LanguageEntry } from "./entries/language";
import { loadRegistryEntry, type RegistryEntry } from "./entries/registry";
import {
    skipComponentEntry,
    skipDeleteEntry,
    skipIniEntry,
    skipMessageEntry,
    skipPermissionEntry,
    skipRunEntry,
    skipTaskEntry,
    skipTypeEntry,
    skipWizardAndPluginsWithHeader,
} from "./entries/skip";
import { InnoFormatError } from "./errors";
import { encryptionUsed, loadHeader, type InnoHeader } from "./header";
import type { UnpackDecoder } from "../unpack";
import { loadOffsets } from "./offsets";
import type { RandomAccessSource } from "../unpack/source";
import { parseGalaxyFiles } from "./goggalaxy";
import { codepageForVersion, readVersionAt } from "./version";

export interface InnoParseResult {
    version: ReturnType<typeof readVersionAt>;
    header: InnoHeader;
    languages: LanguageEntry[];
    directories: DirectoryEntry[];
    files: FileEntry[];
    icons: IconEntry[];
    registryEntries: RegistryEntry[];
    dataEntries: DataEntry[];
    offsets: ReturnType<typeof loadOffsets>;
}

function assertStreamEnd(r: BinaryReader, what: string): void {
    if (!r.isAtEnd()) {
        throw new InnoFormatError(`unknown data at end of ${what}`, r.offset);
    }
}

function loadEntries<T>(
    r: BinaryReader,
    count: number,
    load: (r: BinaryReader, ctx: ParseContext) => T,
    ctx: ParseContext,
): T[] {
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(load(r, ctx));
    return out;
}

function skipEntries(count: number, skip: (r: BinaryReader, ctx: ParseContext) => void, r: BinaryReader, ctx: ParseContext): void {
    for (let i = 0; i < count; i++) skip(r, ctx);
}

/** info.cpp:148-238 — try_load (simplified: no version ladder retry) */
export async function parseInnoHeader(
    source: RandomAccessSource,
    lzmaDecoder?: UnpackDecoder,
): Promise<InnoParseResult> {
    const offsets = loadOffsets(source);
    const versionOffset = offsets.headerOffset;
    const versionBytes = source.readRangeSync(versionOffset, versionOffset + 64);
    const version = readVersionAt(versionBytes, versionOffset);

    const block1Offset = versionOffset + 64;
    const block1 = await decompressBlockStream(source, block1Offset, version, lzmaDecoder);
    const r1 = new BinaryReader(block1, block1Offset);

    let codepage = version.isUnicode() ? 1200 : 1252;
    const header = loadHeader(r1, version, codepage);
    const ctx: ParseContext = { version, codepage, header };

    const languages = loadEntries(r1, header.languageCount, loadLanguageEntry, ctx);
    codepage = codepageForVersion(version, languages);
    ctx.codepage = codepage;

    skipEntries(header.messageCount, skipMessageEntry, r1, ctx);
    skipEntries(header.permissionCount, skipPermissionEntry, r1, ctx);
    skipEntries(header.typeCount, skipTypeEntry, r1, ctx);
    skipEntries(header.componentCount, skipComponentEntry, r1, ctx);
    skipEntries(header.taskCount, skipTaskEntry, r1, ctx);
    const directories = loadEntries(r1, header.directoryCount, loadDirectoryEntry, ctx);

    const files = loadEntries(r1, header.fileCount, loadFileEntry, ctx);
    const icons = loadEntries(r1, header.iconCount, loadIconEntry, ctx);
    skipEntries(header.iniEntryCount, skipIniEntry, r1, ctx);
    const registryEntries = loadEntries(r1, header.registryEntryCount, loadRegistryEntry, ctx);
    skipEntries(header.deleteEntryCount, skipDeleteEntry, r1, ctx);
    skipEntries(header.uninstallDeleteEntryCount, skipDeleteEntry, r1, ctx);
    skipEntries(header.runEntryCount, skipRunEntry, r1, ctx);
    skipEntries(header.uninstallRunEntryCount, skipRunEntry, r1, ctx);

    if (version.atLeast(4, 0, 0)) {
        skipWizardAndPluginsWithHeader(r1, ctx, header.compression, encryptionUsed(header.options));
    }

    assertStreamEnd(r1, "primary header stream");

    const block2Start = getBlockEndOffset(source, block1Offset, version);
    const block2 = await decompressBlockStream(source, block2Start, version, lzmaDecoder);
    const r2 = new BinaryReader(block2, block2Start);
    const dataEntries = loadEntries(r2, header.dataEntryCount, loadDataEntry, ctx);
    assertStreamEnd(r2, "secondary header stream");

    const result: InnoParseResult = {
        version, header, languages, directories, files, icons, registryEntries, dataEntries, offsets,
    };
    parseGalaxyFiles(result);
    return result;
}
