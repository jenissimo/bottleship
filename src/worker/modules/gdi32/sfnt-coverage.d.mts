export interface SfntCoverage {
    glyphs: Uint16Array;
    ranges: number[][];
    total: number;
    codePages: number | null;
}
export function parseSfntCoverage(data: Uint8Array): SfntCoverage | null;
export function encodeGlyphSet(coverage: SfntCoverage): Uint8Array;
