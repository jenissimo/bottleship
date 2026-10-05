/**
 * Skip loaders for entries we don't parse — MUST consume exact bytes.
 * Ported from respective setup/*.cpp skip/load paths in innoextract.
 */

import type { BinaryReader } from "../binary-reader";
import type { ParseContext } from "../context";
import { loadConditionData, loadVersionData } from "./item";
import { loadWindowsVersionRange } from "./windows";

/** setup/message.cpp */
export function skipMessageEntry(r: BinaryReader, ctx: ParseContext): void {
    r.encodedString(ctx.codepage);
    r.skipBinaryString();
    r.i32();
}

/** setup/permission.cpp */
export function skipPermissionEntry(r: BinaryReader, _ctx: ParseContext): void {
    r.skipBinaryString();
}

/** setup/type.cpp */
export function skipTypeEntry(r: BinaryReader, ctx: ParseContext): void {
    const v = ctx.version;
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 1)) r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(1, 3, 24))) r.encodedString(ctx.codepage);
    loadWindowsVersionRange(r, ctx.version.atLeast(1, 3, 19));
    r.storedFlags([1], 32);
    if (v.atLeast(4, 0, 3)) r.storedEnum([0, 1, 2, 3], 0);
    if (v.atLeast(4, 0, 0)) r.u64();
    else r.u32();
}

/** setup/component.cpp */
export function skipComponentEntry(r: BinaryReader, ctx: ParseContext): void {
    const v = ctx.version;
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 1)) r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(1, 3, 24))) r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 0)) r.u64();
    else r.u32();
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(3, 0, 3))) r.i32();
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(3, 0, 4))) r.loadBool();
    loadWindowsVersionRange(r, ctx.version.atLeast(1, 3, 19));
    if (v.atLeast(4, 2, 3)) r.storedFlags([1, 2, 4, 8, 16], 32);
    else if (v.atLeast(3, 0, 8) || (v.isIsx() && v.atLeast(3, 0, 6, 1)))
        r.storedFlags([1, 2, 4, 8], 32);
    else r.storedFlags([1, 2, 4], 32);
    if (v.atLeast(4, 0, 0)) r.u64();
    else if (v.atLeast(2, 0, 0) || (v.isIsx() && v.atLeast(1, 3, 24))) r.u32();
}

/** setup/task.cpp */
export function skipTaskEntry(r: BinaryReader, ctx: ParseContext): void {
    const v = ctx.version;
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 1)) r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(1, 3, 24))) r.encodedString(ctx.codepage);
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(3, 0, 3))) r.i32();
    if (v.atLeast(4, 0, 0) || (v.isIsx() && v.atLeast(3, 0, 4))) r.loadBool();
    loadWindowsVersionRange(r, ctx.version.atLeast(1, 3, 19));
    const fr = r.storedFlagReader(32);
    fr.add(1);
    fr.add(2);
    if (v.atLeast(2, 0, 5)) fr.add(4);
    if (v.atLeast(2, 0, 6)) fr.add(8);
    if (v.atLeast(4, 2, 3)) fr.add(16);
    fr.finalize();
}

/** setup/ini.cpp */
export function skipIniEntry(r: BinaryReader, ctx: ParseContext): void {
    const bits = ctx.version.bits();
    if (ctx.version.value < 0x01030000) r.u32();
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    loadConditionData(r, ctx);
    loadVersionData(r, ctx);
    r.storedFlags([1, 2, 4, 8, 16], bits);
}

/** setup/delete.cpp */
export function skipDeleteEntry(r: BinaryReader, ctx: ParseContext): void {
    if (ctx.version.value < 0x01030000) r.u32();
    r.encodedString(ctx.codepage);
    loadConditionData(r, ctx);
    loadVersionData(r, ctx);
    r.storedEnum([0, 1, 2], 0);
}

/** setup/run.cpp */
export function skipRunEntry(r: BinaryReader, ctx: ParseContext): void {
    const v = ctx.version;
    const bits = v.bits();
    if (v.value < 0x01030000) r.u32();
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    r.encodedString(ctx.codepage);
    if (v.atLeast(1, 3, 9)) r.encodedString(ctx.codepage);
    if (v.atLeast(2, 0, 2)) r.encodedString(ctx.codepage);
    if (v.atLeast(5, 1, 13)) r.encodedString(ctx.codepage);
    if (v.atLeast(2, 0, 0) || v.isIsx()) r.encodedString(ctx.codepage);
    loadConditionData(r, ctx);
    loadVersionData(r, ctx);
    if (v.atLeast(1, 3, 24)) r.loadI32(bits);
    r.storedEnum([0, 1, 2], 0);
    const fr = r.storedFlagReader(bits);
    if (v.atLeast(1, 2, 3)) fr.add(1);
    if (v.atLeast(1, 3, 9) || (v.isIsx() && v.atLeast(1, 3, 8))) fr.add(2);
    if (v.atLeast(2, 0, 0)) {
        fr.add(4);
        fr.add(8);
        fr.add(16);
        fr.add(32);
    }
    if (v.atLeast(2, 0, 8)) fr.add(64);
    if (v.atLeast(5, 1, 10)) {
        fr.add(128);
        fr.add(256);
    }
    if (v.atLeast(5, 2, 0)) fr.add(512);
    if (v.atLeast(6, 1, 0)) fr.add(1024);
    if (v.atLeast(6, 3, 0)) fr.add(2048);
    fr.finalize();
}

/** info.cpp:77-98 — load_wizard_images skip */
export function skipWizardImages(r: BinaryReader, ctx: ParseContext): void {
    const v = ctx.version;
    let count = 1;
    if (v.atLeast(5, 6, 0)) count = r.u32();
    for (let i = 0; i < count; i++) r.skipBinaryString();
}

/** info.cpp:101-134 — load_wizard_and_decompressor skip portions */
export function skipWizardAndPlugins(r: BinaryReader, ctx: ParseContext, compression: number): void {
    const v = ctx.version;
    skipWizardImages(r, ctx);
    if (v.atLeast(2, 0, 0) || v.isIsx()) skipWizardImages(r, ctx);
    const needsDecompressor =
        compression === 2 /* BZip2 */ ||
        (compression === 3 /* LZMA1 */ && v.value === 0x04010500) ||
        (compression === 1 /* Zlib */ && v.atLeast(4, 2, 6));
    if (needsDecompressor) r.skipBinaryString();
    const encryptionUsed = false; // checked from header options in parser
    if (encryptionUsed && v.value < 0x06040000) r.skipBinaryString();
}

export function skipWizardAndPluginsWithHeader(
    r: BinaryReader,
    ctx: ParseContext,
    compression: number,
    encryptionUsed: boolean,
): void {
    const v = ctx.version;
    skipWizardImages(r, ctx);
    if (v.atLeast(2, 0, 0) || v.isIsx()) skipWizardImages(r, ctx);
    const needsDecompressor =
        compression === 2 ||
        (compression === 3 && v.value === 0x04010500) ||
        (compression === 1 && v.atLeast(4, 2, 6));
    if (needsDecompressor) r.skipBinaryString();
    if (encryptionUsed && v.value < 0x06040000) r.skipBinaryString();
}
