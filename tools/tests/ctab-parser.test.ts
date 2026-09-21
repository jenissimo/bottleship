/**
 * Differential test: our CTAB parser vs the shipped d3dx9_43.dll.
 *
 * The fixtures are RECORDED from the real ID3DXConstantTable (tools/d3dx-oracle.ts ctab),
 * so this compares us against Microsoft's answer rather than against a second reading of
 * our own code. Every field a game reads out of D3DXCONSTANT_DESC is asserted, because a
 * wrong RegisterIndex is invisible until the art looks wrong.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseShaderConstantTable, typeBytes, isPixelShaderVersion } from '../../src/worker/modules/d3dx9/ctab';

interface ReferenceConstant {
    name: string;
    registerSet: number;
    registerIndex: number;
    registerCount: number;
    class: number;
    type: number;
    rows: number;
    columns: number;
    elements: number;
    structMembers: number;
    bytes: number;
}

interface Fixture {
    profile: string;
    bytecode: string;
    reference: { creator: string; version: number; constants: ReferenceConstant[] };
}

function load(name: string): { fixture: Fixture; tokens: Uint32Array } {
    const path = join(import.meta.dir, 'fixtures', name);
    const fixture = JSON.parse(readFileSync(path, 'utf-8')) as Fixture;
    const words = fixture.bytecode.split(',').map((s) => Number(s) >>> 0);
    return { fixture, tokens: new Uint32Array(words) };
}

for (const [file, pixel] of [['ctab-sample.ps_3_0.json', true], ['ctab-sample.vs_3_0.json', false]] as const) {
    describe(`CTAB parser vs d3dx9_43 (${file})`, () => {
        const { fixture, tokens } = load(file);
        const table = parseShaderConstantTable(tokens);

        test('finds the table the compiler embedded', () => {
            expect(table).not.toBeNull();
        });

        test('header matches the reference', () => {
            expect(table!.creator).toBe(fixture.reference.creator);
            expect(table!.version >>> 0).toBe(fixture.reference.version >>> 0);
            expect(isPixelShaderVersion(table!.version)).toBe(pixel);
            expect(table!.constants.length).toBe(fixture.reference.constants.length);
        });

        test('every constant matches, field for field', () => {
            const ours = new Map(table!.constants.map((c) => [c.name, c]));
            for (const ref of fixture.reference.constants) {
                const c = ours.get(ref.name);
                expect(c, `missing constant ${ref.name}`).toBeDefined();
                expect({
                    name: c!.name,
                    registerSet: c!.registerSet,
                    registerIndex: c!.registerIndex,
                    registerCount: c!.registerCount,
                    class: c!.type.class,
                    type: c!.type.type,
                    rows: c!.type.rows,
                    columns: c!.type.columns,
                    // D3DX reports a non-array as 1; the file stores 0.
                    elements: Math.max(1, c!.type.elements),
                    structMembers: c!.type.members.length,
                    bytes: typeBytes(c!.type),
                }).toEqual(ref);
            }
        });
    });
}

describe('CTAB parser rejects what is not a table', () => {
    test('a shader with no comment block has no table', () => {
        // vs_1_1: version token, mov oPos, v0, end — nothing else.
        const tokens = new Uint32Array([0xfffe0101, 0x00000001, 0x800f0000, 0x90e40000, 0x0000ffff]);
        expect(parseShaderConstantTable(tokens)).toBeNull();
    });

    test('a truncated table is refused, not half-read', () => {
        const { tokens } = load('ctab-sample.ps_3_0.json');
        // Keep the CTAB comment header but cut the payload the offsets point into.
        const cut = tokens.slice(0, 8);
        cut[1] = tokens[1]!;   // same comment length — now a lie
        expect(parseShaderConstantTable(cut)).toBeNull();
    });
});
