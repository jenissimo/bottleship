/**
 * Static-library HLE across TWO modules of one process.
 *
 * zlib and the PSX ADPCM decoder are exactly the shape that gets statically linked into an
 * engine DLL AND into the exe. Everything the framework remembers about a patch — original
 * bytes, target address, trampoline, and anything the descriptor resolved out of the image —
 * therefore has to be keyed by MODULE. Keyed without it, the second detection overwrites the
 * first's bookkeeping, a later unpatch restores only one copy, and the other keeps jumping
 * into a stub whose runtime is disabled.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
    PSX_COEF_TABLE_X4,
    clearCoefTables,
    decodeExact,
    getCoefTable,
    getCoefTables,
    setCoefTable,
    ST_COUNT,
    ST_DST,
    ST_HIST1,
    ST_HIST2,
    ST_SRC,
} from "../../src/worker/core/hle-lib/libs/psx-adpcm/kernel";
import { LiveShadowView } from "../../src/worker/core/hle-lib/shadow-validator";

const MEM = 0x20000;
const TABLE_A = 0x1000;   // engine DLL's relocated copy
const TABLE_B = 0x1400;   // the exe's copy — different address, same coefficients
const DECODER_A = 0x9000;
const DECODER_B = 0x9800;
const CTX = 0x2000;
const SRC = 0x4000;
const DST = 0x8000;

function mkMem(): Uint8Array {
    const mem = new Uint8Array(MEM);
    const dv = new DataView(mem.buffer);
    for (const table of [TABLE_A, TABLE_B]) {
        for (let i = 0; i < PSX_COEF_TABLE_X4.length; i++) {
            dv.setInt16(table + i * 4, PSX_COEF_TABLE_X4[i][0], true);
            dv.setInt16(table + i * 4 + 2, PSX_COEF_TABLE_X4[i][1], true);
        }
    }
    // Filter 1 ({240,0}) with a fixed payload — enough to make the output depend on the table.
    mem[SRC] = 0x10;
    for (let i = 1; i < 15; i++) mem[SRC + i] = (i * 37 + 11) & 0xff;
    const st = new DataView(mem.buffer);
    st.setInt32(CTX + ST_COUNT, 28, true);
    st.setInt16(CTX + ST_HIST1, 0, true);
    st.setInt16(CTX + ST_HIST2, 0, true);
    st.setUint32(CTX + ST_SRC, SRC, true);
    st.setUint32(CTX + ST_DST, DST, true);
    return mem;
}

beforeEach(() => clearCoefTables());

describe("psx-adpcm coefficient tables are per decoder site", () => {
    test("a second module's detection does not overwrite the first's table", () => {
        setCoefTable(DECODER_A, TABLE_A);
        setCoefTable(DECODER_B, TABLE_B);

        expect(getCoefTable(DECODER_A)).toBe(TABLE_A);
        expect(getCoefTable(DECODER_B)).toBe(TABLE_B);
        expect(getCoefTables().length).toBe(2);
    });

    test("an unknown decoder has no table rather than another module's", () => {
        setCoefTable(DECODER_A, TABLE_A);
        expect(getCoefTable(DECODER_B)).toBe(0);
    });

    test("each site decodes through its OWN table", () => {
        // Make the two tables differ so a mix-up is observable in the samples.
        const memA = mkMem();
        const memB = mkMem();
        for (const m of [memA, memB]) {
            new DataView(m.buffer).setInt16(TABLE_B + 4, 120, true); // filter 1 coef1: 240 -> 120
        }
        setCoefTable(DECODER_A, TABLE_A);
        setCoefTable(DECODER_B, TABLE_B);

        decodeExact(new LiveShadowView(memA), CTX, getCoefTable(DECODER_A));
        decodeExact(new LiveShadowView(memB), CTX, getCoefTable(DECODER_B));

        const a = Array.from(memA.slice(DST, DST + 56));
        const b = Array.from(memB.slice(DST, DST + 56));
        expect(a).not.toEqual(b);
    });

    test("a game switch drops every site — the addresses stop meaning anything", () => {
        setCoefTable(DECODER_A, TABLE_A);
        setCoefTable(DECODER_B, TABLE_B);
        clearCoefTables();
        expect(getCoefTables().length).toBe(0);
        expect(getCoefTable(DECODER_A)).toBe(0);
    });
});
