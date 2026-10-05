/**
 * D3DXAssembleShader / D3DXDisassembleShader against the reference implementation.
 *
 * The contract is Microsoft's answer, not self-consistency: a round trip through
 * our own two halves proves only that they agree with each other and cannot
 * catch both being wrong the same way. The fixtures in
 * tools/tests/fixtures/d3dx-shader-asm.json are RECORDED from the shipped
 * d3dx9_43.dll by tools/gen-d3dx-shader-fixtures.ts (dev-host only, needs
 * Windows + the DirectX redist); this test consumes them and runs everywhere.
 *
 * Both directions are checked against the recording: text → the exact token
 * stream d3dx9 emits, and tokens → the exact text, down to indentation, because
 * the D3D8→D3D9 wrapper rewrites that text with regexes tuned to it.
 */
import { describe, expect, test } from 'bun:test';
import {
    assembleShader, disassembleShader, ShaderAsmError,
} from '../../src/worker/modules/d3dx9/shader-asm';
import { Op, Usage } from '../../src/worker/backends/webgpu/d3d9/shader/sm-enums';
import { parseShader } from '../../src/worker/backends/webgpu/d3d9/shader/sm-parser';
import fixtures from './fixtures/d3dx-shader-asm.json';

/** `asm` is null for streams the reference assembler cannot express (vs_1_0/ps_1_0). */
interface Fixture { name: string; note: string; asm: string | null; tokens: string[]; disasm: string }

/** Sources d3dx9 refuses, with the HRESULT it refuses them with — no bytecode to pin. */
interface RejectFixture { name: string; note: string; asm: string; hr: string }

/** The accept side of a rejection boundary: assembles to the exact tokens d3dx9 emits. */
interface AcceptOnlyFixture { name: string; note: string; asm: string; tokens: string[] }

const CASES: Fixture[] = fixtures.cases;
const REJECT_CASES: RejectFixture[] = fixtures.rejectCases;
const ACCEPT_ONLY_CASES: AcceptOnlyFixture[] = fixtures.acceptOnlyCases;
const byName = (name: string): Fixture => {
    const found = CASES.find((c) => c.name === name);
    if (!found) throw new Error(`fixture '${name}' is missing — re-record`);
    return found;
};

/** Hex strings, so a failure names the offending token instead of "arrays differ". */
const hex = (tokens: Uint32Array): string[] =>
    [...tokens].map((t) => '0x' + (t >>> 0).toString(16).padStart(8, '0'));

const tokensOf = (fixture: Fixture): Uint32Array =>
    new Uint32Array(fixture.tokens.map((t) => Number(t) >>> 0));

describe('assembling matches the tokens d3dx9 emits', () => {
    for (const fixture of CASES) {
        if (!fixture.asm) continue;
        test(`${fixture.name} — ${fixture.note}`, () => {
            expect(hex(assembleShader(fixture.asm!))).toEqual(fixture.tokens);
        });
    }
});

describe('disassembling matches the text d3dx9 emits', () => {
    for (const fixture of CASES) {
        test(`${fixture.name} — ${fixture.note}`, () => {
            expect(disassembleShader(tokensOf(fixture))).toBe(fixture.disasm);
        });
    }

    test('and that text assembles back to the very same tokens', () => {
        for (const fixture of CASES) {
            expect(hex(assembleShader(fixture.disasm))).toEqual(fixture.tokens);
        }
    });

    test('a comment block (fxc CTAB) is dropped, as native D3DX drops it', () => {
        const original = tokensOf(byName('vs_1_1_skinned'));
        const withCtab = new Uint32Array([
            original[0],
            (0xFFFE | (4 << 16)) >>> 0, 0x42415443, 0, 1, 2,
            ...original.slice(1),
        ]);
        expect(disassembleShader(withCtab)).toBe(byName('vs_1_1_skinned').disasm);
    });
});

describe('the edits a D3D8→D3D9 wrapper makes between the two calls', () => {
    test('inserting dcl_* lines after the four-space-indented version line', () => {
        // A D3D8-era vertex shader has no input declarations; the wrapper adds
        // them from the D3D8 vertex declaration before re-assembling.
        const bare = assembleShader('vs_1_1\nm4x4 oPos, v0, c0\nmov oT0, v7\n');
        let text = disassembleShader(bare);
        const marker = '    vs_1_1\n';
        expect(text).toContain(marker);
        text = text.replace(marker, marker
            + '    dcl_position v0\n'
            + '    dcl_blendweight v1\n'
            + '    dcl_blendindices v2\n'
            + '    dcl_normal v3\n'
            + '    dcl_psize v4\n'
            + '    dcl_color v5\n'
            + '    dcl_texcoord v7\n');

        const program = parseShader(assembleShader(text));
        expect(program.declarations.map((d) => [d.usage, d.reg.num])).toEqual([
            [Usage.POSITION, 0], [Usage.BLENDWEIGHT, 1], [Usage.BLENDINDICES, 2],
            [Usage.NORMAL, 3], [Usage.PSIZE, 4], [Usage.COLOR, 5], [Usage.TEXCOORD, 7],
        ]);
        expect(program.instructions.map((i) => i.opcode)).toEqual([Op.M4x4, Op.MOV]);
    });

    test('rewriting the version header to vs_1_1', () => {
        const vs10 = assembleShader('vs_1_0\nmov oPos, v0\n');
        const text = disassembleShader(vs10).replace('    vs_1_0', '    vs_1_1');
        expect(parseShader(assembleShader(text)).minor).toBe(1);
    });

    test('ps_1_[0-3] → "    ps_1_4 /* converted */", block comment and all', () => {
        const ps13 = assembleShader('ps_1_3\ntex t0\nmov r0, t0\n');
        // The wrapper's ps_1_4 spelling of the same code: tex gains its source.
        const text = disassembleShader(ps13)
            .replace('    ps_1_3', '    ps_1_4 /* converted */')
            .replace('    tex t0', '    texld r0, t0')
            .replace('    mov r0, t0', '    mov r0, r0');

        const program = parseShader(assembleShader(text));
        expect([program.isPixelShader, program.major, program.minor]).toEqual([true, 1, 4]);
        expect(program.instructions[0].opcode).toBe(Op.TEX);
        expect(program.instructions[0].src.length).toBe(1);
    });

    test('CRLF, tabs, ; comments and uppercase mnemonics all assemble', () => {
        const canonical = assembleShader('vs_1_1\nmov oPos, v0\n');
        const foreign = '; a legacy comment\r\n\tVS_1_1\r\n\tMOV oPos, v0\t// trailing\r\n';
        expect(hex(assembleShader(foreign))).toEqual(hex(canonical));
    });
});

describe('the assembler fails honestly', () => {
    const expectError = (source: string, line: number, fragment: string) => {
        let caught: unknown;
        try { assembleShader(source); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(ShaderAsmError);
        const error = caught as ShaderAsmError;
        expect(error.line).toBe(line);
        expect(error.message).toContain(fragment);
    };

    test('unknown instruction reports its line', () => {
        expectError('vs_1_1\nmov oPos, v0\nfrobnicate r0, r1\n', 3, "unknown instruction 'frobnicate'");
    });

    test('unknown register reports its line', () => {
        expectError('vs_1_1\nmov oPos, q9\n', 2, "unknown register 'q9'");
    });

    test('wrong operand count for shader model 1.x is rejected', () => {
        expectError('ps_1_1\ntex t0, t1\n', 2, 'takes 1 operand');
    });

    test('#include / #define are refused rather than ignored', () => {
        expectError('vs_1_1\n#include "common.vsh"\nmov oPos, v0\n', 2, 'preprocessor directives');
    });

    test('an empty source is an error, not an empty shader', () => {
        expectError('   \n\n// nothing here\n', 0, 'empty');
    });

    test('a missing version line is an error', () => {
        expectError('mov oPos, v0\n', 1, 'expected a shader version');
    });
});

/**
 * Boundaries the real d3dx9 enforces that our assembler used to miss entirely
 * (it accepted these and emitted bytecode). Each is recorded from the shipped
 * DLL — REJECT_CASES via tools/d3dx-oracle.ts's assemble(), which reports the
 * HRESULT it refused with — so this is checked against Microsoft's answer, not
 * our own expectations of what should fail.
 */
describe('register-kind, def-destination and shader-model boundaries d3dx9 rejects', () => {
    for (const fixture of REJECT_CASES) {
        test(`${fixture.name} — ${fixture.note} (real DLL hr=${fixture.hr})`, () => {
            let caught: unknown;
            try { assembleShader(fixture.asm); } catch (e) { caught = e; }
            expect(caught).toBeInstanceOf(ShaderAsmError);
        });
    }
});

/**
 * The accept side of each boundary above, so the fix can't pass by rejecting
 * everything nearby. setp/texldd/texldl/breakp have no prior fixture coverage
 * at their legal shader model, so ACCEPT_ONLY_CASES adds it (token-exact
 * against d3dx9, no disassembly round-trip — see its note in the generator).
 * The t#/a# register-kind and def/defi/defb destination-kind accept
 * boundaries are already exercised byte-exactly by CASES above; this just
 * names which existing fixtures carry that coverage.
 */
describe('the accept side of those same boundaries', () => {
    for (const fixture of ACCEPT_ONLY_CASES) {
        test(`${fixture.name} — ${fixture.note}`, () => {
            expect(hex(assembleShader(fixture.asm))).toEqual(fixture.tokens);
        });
    }

    test('t# is legal in a pixel shader (ps_1_1_coissue, ps_1_2_texops, ps_2_0_texld)', () => {
        for (const name of ['ps_1_1_coissue', 'ps_1_2_texops', 'ps_2_0_texld']) {
            expect(hex(assembleShader(byName(name).asm!))).toEqual(byName(name).tokens);
        }
    });

    test('a# is legal in a vertex shader (vs_1_1_relative mov + vs_2_0_loop mova)', () => {
        for (const name of ['vs_1_1_relative', 'vs_2_0_loop']) {
            expect(hex(assembleShader(byName(name).asm!))).toEqual(byName(name).tokens);
        }
    });

    test('def/defi/defb dest c#/i#/b# with no mask is legal (vs_2_0_loop, vs_2_0_constants)', () => {
        for (const name of ['vs_2_0_loop', 'vs_2_0_constants']) {
            expect(hex(assembleShader(byName(name).asm!))).toEqual(byName(name).tokens);
        }
    });

    test('mova is legal in vs_2_0+ (vs_2_0_loop)', () => {
        expect(hex(assembleShader(byName('vs_2_0_loop').asm!))).toEqual(byName('vs_2_0_loop').tokens);
    });
});
