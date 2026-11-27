export function parseSfntCoverage(data) {
    try {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const fits = (o, n) => Number.isSafeInteger(o) && o >= 0 && n >= 0 && o + n <= v.byteLength;
        if (!fits(0, 12)) return null;
        const version = v.getUint32(0);
        if (![0x10000, 0x4f54544f, 0x74727565].includes(version)) return null;
        const tables = new Map(), n = v.getUint16(4);
        if (!fits(12, n * 16)) return null;
        for (let i = 0; i < n; i++) {
            const r = 12 + i * 16, tag = v.getUint32(r), off = v.getUint32(r + 8), len = v.getUint32(r + 12);
            if (!fits(off, len)) return null;
            tables.set(tag, { off, len });
        }
        const cmap = tables.get(0x636d6170), maxp = tables.get(0x6d617870);
        if (!cmap || cmap.len < 4 || !maxp || maxp.len < 6) return null;
        const glyphCount = v.getUint16(maxp.off + 4), records = v.getUint16(cmap.off + 2);
        if (4 + records * 8 > cmap.len) return null;
        const candidates = [];
        for (let i = 0; i < records; i++) {
            const r = cmap.off + 4 + i * 8, platform = v.getUint16(r), encoding = v.getUint16(r + 2);
            if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
            const offset = v.getUint32(r + 4);
            if (offset + 2 > cmap.len) continue;
            const sub = cmap.off + offset, format = v.getUint16(sub);
            if (format !== 4 && format !== 12) continue;
            if (offset + (format === 12 ? 16 : 14) > cmap.len) continue;
            const len = format === 12 ? v.getUint32(sub + 4) : v.getUint16(sub + 2);
            if (offset + len > cmap.len) continue;
            candidates.push({ sub, format, len, score: (format === 12 ? 10 : 0) + (platform === 3 ? 2 : 1) });
        }
        candidates.sort((a, b) => b.score - a.score);
        const c = candidates[0]; if (!c) return null;
        const glyphs = new Uint16Array(65536), { sub, format, len } = c;
        if (format === 4) {
            const segs = v.getUint16(sub + 6) / 2;
            if (!Number.isInteger(segs) || !segs || 16 + 8 * segs > len) return null;
            const starts = sub + 16 + 2 * segs, deltas = starts + 2 * segs, offsets = deltas + 2 * segs;
            let previous = -1;
            for (let i = 0; i < segs; i++) {
                const end = v.getUint16(sub + 14 + i * 2), start = v.getUint16(starts + i * 2);
                if (start > end || start <= previous) return null;
                previous = end;
                const delta = v.getInt16(deltas + i * 2), ro = v.getUint16(offsets + i * 2);
                for (let ch = start; ch <= end && ch < 0xffff; ch++) {
                    let glyph;
                    if (!ro) glyph = (ch + delta) & 65535;
                    else {
                        const at = offsets + i * 2 + ro + 2 * (ch - start);
                        if (at < sub || at + 2 > sub + len) return null;
                        glyph = v.getUint16(at);
                        if (glyph) glyph = (glyph + delta) & 65535;
                    }
                    if (glyph > 0 && glyph < glyphCount && !(ch >= 0xd800 && ch <= 0xdfff)) glyphs[ch] = glyph;
                }
            }
        } else {
            const groups = v.getUint32(sub + 12);
            if (16 + 12 * groups > len) return null;
            let previous = -1;
            for (let i = 0; i < groups; i++) {
                const at = sub + 16 + i * 12, start = v.getUint32(at), end = v.getUint32(at + 4), first = v.getUint32(at + 8);
                if (start > end || start <= previous || end > 0x10ffff) return null;
                previous = end;
                for (let ch = start; ch <= Math.min(end, 0xfffe); ch++) {
                    const glyph = first + ch - start;
                    if (glyph > 0 && glyph < glyphCount && !(ch >= 0xd800 && ch <= 0xdfff)) glyphs[ch] = glyph;
                }
            }
        }
        const ranges = [];
        let total = 0;
        for (let ch = 0; ch < 65536;) {
            if (!glyphs[ch]) { ch++; continue; }
            const start = ch;
            while (ch < 65536 && glyphs[ch] && ch - start < 65535) { ch++; total++; }
            ranges.push([start, ch - start]);
        }
        const os2 = tables.get(0x4f532f32);
        const codePages = os2 && os2.len >= 86 && v.getUint16(os2.off) >= 1 ? v.getUint32(os2.off + 78) : null;
        return { glyphs, ranges, total, codePages };
    } catch { return null; }
}

export function encodeGlyphSet(coverage) {
    const size = 16 + coverage.ranges.length * 4;
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, size, true);
    view.setUint32(8, coverage.total, true);
    view.setUint32(12, coverage.ranges.length, true);
    coverage.ranges.forEach(([start, count], i) => {
        view.setUint16(16 + i * 4, start, true);
        view.setUint16(18 + i * 4, count, true);
    });
    return bytes;
}
