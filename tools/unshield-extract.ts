#!/usr/bin/env bun
/**
 * unshield-extract: Extract InstallShield Cabinet (ISc) version-5 AND version-6 cabinets.
 *
 * A self-contained TypeScript port of the file-reading core of `unshield`
 * (twogood/unshield) for IS5 (major_version 5) and IS6+ (major_version 6..13)
 * cabinets (signature "ISc(") — the format used by many 1998-2003 era Win32
 * game installers. Reads the <name>1.hdr header + <name>{1,2,...}.cab data
 * volumes, decompresses (per-chunk raw-deflate), de-obfuscates, follows
 * LINK_PREV dedup links (v6+), handles volume-split files, and validates each
 * file against its stored expanded size + MD5.
 *
 * The cabinet header/descriptor LAYOUT parsing is shared with the browser core
 * (`packages/formats/src/installshield/index.ts`); this CLI reuses that parser and adds
 * its own Node-side fs + sync zlib for fast extraction.
 *
 * Usage:
 *   bun tools/unshield-extract.ts <data1.hdr> <out-dir> [--list] [--quiet]
 *
 *   <data1.hdr>   path to the cabinet header (the .hdr; .cab volumes sit beside it)
 *   <out-dir>     destination directory (created); files land under <dir-name>/<file-name>
 *   --list        only print the file table; do not extract
 *   --quiet       suppress per-file progress
 *
 * Not supported: encryption.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { inflateRawSync } from 'zlib';
import { dirname, join, basename } from 'path';
import { resolveArchiveExtractPath } from './internal/archive-extract-path';
import {
  parseInstallShieldHeader,
  fileRelPath,
  FILE_SPLIT,
  FILE_OBFUSCATED,
  FILE_COMPRESSED,
  FILE_INVALID,
  LINK_PREV,
  type InstallShieldFile,
} from '@bottleship/formats/installshield/index.ts';

const COMMON_HEADER_SIZE = 20;

function parseArgs() {
  const a = process.argv.slice(2);
  if (a.length < 2) { console.error('Usage: bun tools/unshield-extract.ts <data1.hdr> <out-dir> [--list] [--quiet]'); process.exit(1); }
  return { hdrPath: a[0]!, outDir: a[1]!, list: a.includes('--list'), quiet: a.includes('--quiet') };
}

const { hdrPath, outDir, list, quiet } = parseArgs();
const hdr = new Uint8Array(readFileSync(hdrPath));

let info;
try {
  info = parseInstallShieldHeader(hdr);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { major, dirs, files } = info;

// ---- volume loading (Node fs) ----
const volCache = new Map<number, Uint8Array>();
function volBuf(vol: number): Uint8Array {
  if (!volCache.has(vol)) {
    const dir = dirname(hdrPath);
    const stem = basename(hdrPath).replace(/1\.hdr$/i, '');
    const path = join(dir, `${stem}${vol}.cab`);
    volCache.set(vol, new Uint8Array(readFileSync(path)));
  }
  return volCache.get(vol)!;
}
function volHeader(vol: number) {
  const b = volBuf(vol);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const p = COMMON_HEADER_SIZE;
  if (major <= 5) {
    let lastFileOffset = dv.getUint32(p + 28, true);
    if (lastFileOffset === 0) lastFileOffset = 0x7fffffff;
    return {
      firstFileOffset: dv.getUint32(p + 16, true),
      firstFileSizeExpanded: dv.getUint32(p + 20, true),
      firstFileSizeCompressed: dv.getUint32(p + 24, true),
      lastFileOffset,
      lastFileSizeExpanded: dv.getUint32(p + 32, true),
      lastFileSizeCompressed: dv.getUint32(p + 36, true),
    };
  }
  return {
    firstFileOffset: dv.getUint32(p + 16, true),
    firstFileSizeExpanded: dv.getUint32(p + 24, true),
    firstFileSizeCompressed: dv.getUint32(p + 32, true),
    lastFileOffset: dv.getUint32(p + 40, true),
    lastFileSizeExpanded: dv.getUint32(p + 48, true),
    lastFileSizeCompressed: dv.getUint32(p + 56, true),
  };
}

console.log(`ISc v${major}  dirs=${dirs.length}  files=${files.length}`);
console.log('directories:', JSON.stringify(dirs));

if (list) {
  const byVol: Record<number, number> = {}, byDir: Record<string, number> = {};
  let splits = 0, obf = 0, links = 0, invalid = 0, totalExp = 0;
  for (const f of files) {
    byVol[f.volume] = (byVol[f.volume] ?? 0) + 1;
    byDir[f.dir] = (byDir[f.dir] ?? 0) + 1;
    if (f.flags & FILE_SPLIT) splits++;
    if (f.flags & FILE_OBFUSCATED) obf++;
    if (f.linkFlags & LINK_PREV) links++;
    if ((f.flags & FILE_INVALID) || f.dataOffset === 0) invalid++; else totalExp += f.expanded;
  }
  console.log('by volume:', byVol, ' by dir:', byDir);
  console.log(`splits=${splits} obfuscated=${obf} links=${links} invalid/notInCab=${invalid} totalExpanded=${(totalExp/1048576).toFixed(1)}MB`);
  console.log('\nidx  vol off          flags exp        comp       dir/name');
  for (const f of files) {
    const tag = ((f.flags & FILE_INVALID) || f.dataOffset === 0) ? 'INVALID' : '';
    console.log(`${String(f.index).padStart(4)} ${f.volume}  0x${f.dataOffset.toString(16).padStart(9,'0')} ${f.flags.toString(2).padStart(4,'0')}  ${String(f.expanded).padStart(9)} ${String(f.compressed).padStart(9)}  ${fileRelPath(f)} ${tag}`);
  }
  process.exit(0);
}

// ---- extraction ----
function readRaw(fd: InstallShieldFile, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let written = 0;
  let vol = fd.volume;
  let pos: number, volLeft: number;
  if (fd.flags & FILE_SPLIT) {
    const vh = volHeader(vol);
    pos = vh.lastFileOffset; volLeft = (fd.flags & FILE_COMPRESSED) ? vh.lastFileSizeCompressed : vh.lastFileSizeExpanded;
  } else {
    pos = fd.dataOffset; volLeft = size;
  }
  while (written < size) {
    const b = volBuf(vol);
    const want = Math.min(size - written, volLeft);
    out.set(b.subarray(pos, pos + want), written);
    written += want; pos += want; volLeft -= want;
    if (written >= size) break;
    vol++;
    const vh = volHeader(vol);
    pos = vh.firstFileOffset; volLeft = (fd.flags & FILE_COMPRESSED) ? vh.firstFileSizeCompressed : vh.firstFileSizeExpanded;
  }
  if (fd.flags & FILE_OBFUSCATED) deobfuscate(out);
  return out;
}

function deobfuscate(buf: Uint8Array): void {
  let seed = 0;
  for (let i = 0; i < buf.length; i++, seed++) {
    const x = buf[i]! ^ 0xd5;
    const ror = ((x >>> 2) | (x << 6)) & 0xff;
    buf[i] = (ror - (seed % 0x47)) & 0xff;
  }
}

function extractFile(fd: InstallShieldFile): Uint8Array | null {
  if ((fd.flags & FILE_INVALID) || fd.dataOffset === 0 || !fd.name) return null;
  if (fd.linkFlags & LINK_PREV) return extractFile(files[fd.linkPrev]!);

  if (!(fd.flags & FILE_COMPRESSED)) {
    return readRaw(fd, fd.expanded);
  }
  const raw = readRaw(fd, fd.compressed);
  const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: Uint8Array[] = [];
  let off = 0, produced = 0;
  while (produced < fd.expanded) {
    if (off + 2 > raw.length) throw new Error(`chunk header past end (${fd.name})`);
    const len = rv.getUint16(off, true); off += 2;
    if (len === 0) throw new Error(`zero chunk len (${fd.name})`);
    const chunk = raw.subarray(off, off + len); off += len;
    const dec = new Uint8Array(inflateRawSync(chunk));
    out.push(dec); produced += dec.length;
  }
  const merged = new Uint8Array(produced);
  let o = 0;
  for (const part of out) { merged.set(part, o); o += part.length; }
  return merged;
}

let ok = 0, fail = 0, skipped = 0, md5fail = 0;
mkdirSync(outDir, { recursive: true });
for (const fd of files) {
  if ((fd.flags & FILE_INVALID) || fd.dataOffset === 0 || !fd.name) { skipped++; continue; }
  try {
    const data = extractFile(fd);
    if (!data) { skipped++; continue; }
    if (data.length !== fd.expanded) { console.error(`SIZE MISMATCH ${fileRelPath(fd)}: got ${data.length} want ${fd.expanded}`); fail++; continue; }
    if (fd.md5) {
      const sum = new Uint8Array(createHash('md5').update(data).digest());
      let eq = sum.length === fd.md5.length;
      for (let i = 0; eq && i < sum.length; i++) if (sum[i] !== fd.md5[i]) eq = false;
      if (!eq) { console.error(`MD5 FAIL ${fileRelPath(fd)}`); md5fail++; }
    }
    const dest = resolveArchiveExtractPath(outDir, fileRelPath(fd));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    ok++;
    if (!quiet && ok % 50 === 0) console.log(`  ...${ok} files`);
  } catch (e) { console.error(`FAIL ${fileRelPath(fd)}: ${(e as Error).message}`); fail++; }
}
console.log(`\nDONE  extracted=${ok}  skipped=${skipped}  failed=${fail}  md5fail=${md5fail}`);
