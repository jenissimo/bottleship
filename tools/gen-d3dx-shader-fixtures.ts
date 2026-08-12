#!/usr/bin/env bun
/**
 * Record D3DXAssembleShader/D3DXDisassembleShader fixtures from the REAL d3dx9
 * on this host (tools/d3dx-oracle.ts) into tools/tests/fixtures/.
 *
 * DEV-HOST ONLY (Windows + the DirectX redist). The recorded JSON is committed
 * and the test that consumes it runs everywhere, so our two halves are compared
 * against Microsoft's answer rather than against each other.
 *
 * Usage: bun tools/gen-d3dx-shader-fixtures.ts [--check]
 *   --check  re-record into memory and diff against the committed file
 */
import { assemble, disassemble } from './d3dx-oracle';

const OUTPUT = 'tools/tests/fixtures/d3dx-shader-asm.json';

interface Case {
    name: string;
    note: string;
    asm: string;
    /**
     * Rewrite the version token after assembly. D3DX's assembler silently
     * upgrades vs_1_0/ps_1_0 sources to _1_1, but a D3D8 game's shipped bytecode
     * really does carry those versions, so the only way to record the reference
     * DISASSEMBLY of one is to patch the token the assembler produced.
     */
    versionOverride?: number;
}

const CASES: Case[] = [
    {
        name: 'vs_1_1_skinned',
        note: 'GTA III shape: skinning + env-map inputs, matrix macro, modifiers, swizzles, partial masks',
        asm: `vs_1_1
dcl_position v0
dcl_blendweight v1
dcl_blendindices v2
dcl_normal v3
dcl_texcoord1 v7
def c95, 0.5, -1.0, 2.5, 0.0
m4x4 oPos, v0, c0
dp3 r0.xyz, v3, -c8
mov r0.w, c95.x
mad r1, r0.wzyx, c95.x, v1
mul r2, r0, c95
mov oD0, r1
mov oT0.xy, v7
mov oFog, r2.w
`,
    },
    {
        name: 'vs_1_1_relative',
        note: 'SM1.x relative constant addressing — D3DX prints c0[a0.x], accepts c[a0.x + N]',
        asm: `vs_1_1
dcl_position v0
mov a0.x, v0.x
mov oPos, c[a0.x]
mov oD0, c[a0.x + 12]
`,
    },
    {
        name: 'ps_1_1_coissue',
        note: 'co-issued rgb/alpha pair, source modifiers (_bx2/_bias/1-), result shifts, _sat',
        asm: `ps_1_1
def c0, 1.0, 0.0, 0.25, -0.5
tex t0
tex t1
mul r0.rgb, t0, v0
+mov r0.a, t1.a
mad_x2 r0, t0_bx2, c0, r0_bias
lrp r1, 1-r0, t0_bias, t1_bx2
mul_x4_sat r0, r1, c0
`,
    },
    {
        name: 'ps_1_1_arithmetic_only',
        note: 'no texture instruction — the slot summary drops its texture/arithmetic breakdown',
        asm: `ps_1_1
def c0, 1.0, 0.0, 0.0, 0.0
texkill t0
mov r0, c0
add r0, r0, c0
`,
    },
    {
        name: 'ps_1_4_phases',
        note: 'ps_1_4 spellings (texld/texcrd) and their extra operand, phase separator',
        asm: `ps_1_4
texcrd r1.rgb, t1
texld r0, t0
mul r0.rgb, r0, r1
+mov r0.a, r0.a
phase
texld r2, r0
mov_sat r0, r2
`,
    },
    {
        name: 'vs_2_0_loop',
        note: 'length-tagged tokens, defi, mova, relative addressing, loop/endloop indentation',
        asm: `vs_2_0
dcl_position v0
dcl_texcoord v1
defi i0, 4, 0, 1, 0
def c0, 1.0, 0.0, 0.5, -2.0
mova a0.x, v0.x
mov r0, c[a0.x + 3]
loop aL, i0
add r0, r0, c[aL + 1]
endloop
mov oPos, r0
mov oT0, v1
`,
    },
    {
        name: 'vs_2_0_constants',
        note: 'constant printing: -0, denormal-ish exponents, 9-significant-digit rounding, defb',
        asm: `vs_2_0
dcl_position v0
defi i0, 4, 2, 1, 0
defb b0, false
def c0, -0.0, 0.0000001, 1234567, 3.1415927
def c1, 100000000, 0.333333333, -1.5e-30, 65504
mov oPos, v0
`,
    },
    {
        name: 'vs_3_0_flow',
        note: 'nested block indentation, if/else/endif, if_gt comparison, o# outputs',
        asm: `vs_3_0
dcl_position v0
dcl_texcoord v1
defb b0, true
defi i0, 2, 0, 1, 0
def c0, 1.0, 0.0, 0.5, -2.0
dcl_position o0
dcl_texcoord o1
mov r0, v0
rep i0
if b0
add r0, r0, c0
else
mul r0, r0, c0
endif
endrep
if_gt r0.x, c0.y
mul r0, r0, c0.z
endif
mov o0, r0
mov o1, v1
`,
    },
    {
        name: 'ps_2_0_texld',
        note: 'semantic-less input dcl, sampler dcl, texldp/texldb modifiers, _pp',
        asm: `ps_2_0
dcl t0
dcl_2d s0
def c0, 1.0, 0.0, 0.0, 0.0
texld r0, t0, s0
texldp r1, t0, s0
texldb r2, t0, s0
mad_pp r0, r0, r1, r2
cmp r0, r0, r0, -r0
dp2add r0.x, r0, r0, r0.z
mov oC0, r0
`,
    },
    {
        name: 'vs_1_1_arithmetic_zoo',
        note: 'the SM1 vertex arithmetic set: rcp/rsq/dst/frc/min/max/slt/sge/sub/lit/exp/log/m3x3',
        asm: `vs_1_1
dcl_position v0
dcl_normal v3
m4x4 oPos, v0, c0
m3x3 r0.xyz, v3, c4
mov r0.w, c4.x
rcp r1.x, r0.x
rsq r1.y, r0.y
mov r1.zw, c4.x
dst r2, r0, r0
frc r3.xy, v0
mov r3.zw, c4.x
min r4, r0, r1
max r4, r4, r2
slt r5, r4, r3
sge r5, r5, r4
sub r5, r5, r4
lit r6, r5
expp r6.x, r5.x
logp r6.y, r5.y
mov oD0, r6
`,
    },
    {
        name: 'ps_1_2_texops',
        note: 'ps_1_2 texture-addressing instructions on the D3D8 fixed-function-ish path',
        asm: `ps_1_2
tex t0
tex t1
dp3 r0, t0_bx2, t1_bx2
mad r0, r0, r0, r0
`,
    },
    {
        name: 'vs_1_0_bytecode',
        note: 'a real D3D8 vs_1_0 stream (the assembler upgrades sources, shipped bytecode does not)',
        asm: `vs_1_1
dcl_position v0
dcl_normal v3
mov oPos, v0
dp3 oD0.x, v3, c0
`,
        versionOverride: 0xfffe0100,
    },
    {
        name: 'ps_1_0_bytecode',
        note: 'a real D3D8 ps_1_0 stream — the version the wrapper rewrites to ps_1_4',
        asm: `ps_1_1
tex t0
mov r0, t0
`,
        versionOverride: 0xffff0100,
    },
    {
        name: 'ps_3_0_misc',
        note: 'vPos/vFace declarations, oDepth, the _abs source modifier',
        asm: `ps_3_0
dcl_texcoord v0
dcl_2d s0
dcl vPos.xy
dcl vFace
texld r0, v0, s0
mov oC0, -r0_abs
mov oDepth, r0.x
`,
    },
];

/**
 * Sources at the ACCEPT side of a rejection boundary below — recorded as
 * {name, note, asm, tokens} only (no `disasm`). These deliberately skip the
 * disassembly round-trip: the real disassembler's "approximately N slots"
 * summary buckets some SM3 opcodes (e.g. TEXLDD splits across texture AND
 * arithmetic) in a way this file's SLOT_COST table was never calibrated for,
 * and calibrating that estimate is unrelated to what these cases exist to
 * prove — that a legal SM3 instruction assembles to the exact bytecode d3dx9
 * emits, i.e. that the new availability gate doesn't over-reject.
 */
interface AcceptOnlyCase { name: string; note: string; asm: string }

const ACCEPT_ONLY_CASES: AcceptOnlyCase[] = [
    {
        name: 'setp_texldd_texldl_at_sm3',
        note: 'the accept side of setp/texldd/texldl needing SM3, not SM1 or SM2',
        asm: `ps_3_0
dcl_texcoord v0
dcl_2d s0
def c0, 1.0, 1.0, 1.0, 1.0
setp_gt p0, c0, c0
texldl r0, v0, s0
texldd r1, v0, s0, v0, v0
add r2, r0, r1
mov oC0, r2
`,
    },
    {
        name: 'breakp_at_sm3',
        note: 'the accept side of breakp needing SM3',
        asm: `vs_3_0
dcl_position v0
dcl_position o0
def c0, 1.0, 1.0, 1.0, 1.0
defi i0, 4, 0, 1, 0
setp_gt p0, c0, c0
rep i0
breakp p0.x
endrep
mov o0, v0
`,
    },
];

/**
 * Sources the real assembler REJECTS. Recorded as {name, note, asm, hr} rather
 * than the accept-case shape (tokens/disasm) — there is no bytecode to pin, only
 * that d3dx9 refuses it and the HRESULT it refuses with. Each covers a boundary
 * the assembler must enforce; the accept side of the same boundary lives in
 * CASES above (or an existing case) so a fix can't over-reject its way to green.
 */
interface RejectCase { name: string; note: string; asm: string }

const REJECT_CASES: RejectCase[] = [
    {
        name: 'vs_register_kind_t_in_vertex_shader',
        note: 't# is the pixel-shader texture register; numerically identical a#/t# do not cross stages',
        asm: 'vs_1_1\nmov t0.x, v0.x\n',
    },
    {
        name: 'ps_register_kind_a_in_pixel_shader',
        note: 'a# is the vertex-shader address register; same encoding as t#, wrong spelling for this stage',
        asm: 'ps_1_1\nmov r0, a0\n',
    },
    {
        name: 'def_dest_wrong_register_kind',
        note: 'def must write a c# constant register, not a general-purpose one',
        asm: 'vs_1_1\ndef r0, 1.0, 2.0, 3.0, 4.0\n',
    },
    {
        name: 'def_dest_write_mask',
        note: 'def writes the whole constant; a partial write mask has no meaning',
        asm: 'vs_1_1\ndef c0.xy, 1.0, 2.0, 3.0, 4.0\n',
    },
    {
        name: 'defi_dest_wrong_register_kind',
        note: 'defi must write an i# integer constant register',
        asm: 'vs_2_0\ndefi r0, 1, 2, 3, 4\n',
    },
    {
        name: 'defb_dest_wrong_register_kind',
        note: 'defb must write a b# boolean constant register',
        asm: 'vs_2_0\ndefb r0, true\n',
    },
    {
        name: 'setp_not_available_in_sm1',
        note: 'SETP needs predicate support (SM3 in this assembler\'s non-extended version grammar)',
        asm: 'vs_1_1\nsetp_gt p0, c0, c1\n',
    },
    {
        name: 'mova_not_available_in_sm1',
        note: 'MOVA needs SM2+; a0 as a destination is otherwise legal VS spelling, isolating the version gate from the register-kind one',
        asm: 'vs_1_1\nmova a0.x, v0.x\n',
    },
    {
        name: 'mova_not_available_in_pixel_shader',
        note: 'MOVA addresses the vertex-shader constant file; pixel shaders have no a0 to move into',
        asm: 'ps_1_1\nmova a0.x, t0.x\n',
    },
    {
        name: 'texldd_not_available_below_sm3',
        note: 'TEXLDD (gradient texture sample) needs SM3, not merely SM2',
        asm: 'ps_2_0\ndcl t0\ndcl_2d s0\ntexldd r0, t0, s0, t0, t0\n',
    },
    {
        name: 'breakp_not_available_below_sm3',
        note: 'BREAKP needs SM3, not merely SM2',
        asm: 'vs_2_0\nbreakp p0\n',
    },
    {
        name: 'mova_not_available_at_sm3_pixel_shader',
        note: 'MOVA is unavailable to pixel shaders at every shader model, not just SM1',
        asm: 'ps_3_0\nmova a0.x, v0.x\n',
    },
    {
        name: 'texldd_not_available_in_vertex_shader',
        note: 'TEXLDD needs screen-space derivatives, which a vertex shader has none of',
        asm: 'vs_3_0\ndcl_position v0\ndcl_2d s0\ntexldd r0, v0, s0, v0, v0\nmov oPos, v0\n',
    },
];

function record() {
    const cases = CASES.map((entry) => {
        const assembled = assemble(entry.asm);
        if (!assembled.tokens) throw new Error(`${entry.name}: oracle refused the source: ${assembled.error}`);
        if (entry.versionOverride !== undefined) assembled.tokens[0] = entry.versionOverride;
        const disassembled = disassemble(assembled.tokens);
        if (!disassembled.text) throw new Error(`${entry.name}: oracle could not disassemble its own output`);
        return {
            name: entry.name,
            note: entry.note,
            // A patched stream is no longer what `asm` assembles to, so it is
            // recorded as a disassembly-only case.
            asm: entry.versionOverride === undefined ? entry.asm : null,
            tokens: [...assembled.tokens].map((t) => '0x' + t.toString(16).padStart(8, '0')),
            disasm: disassembled.text,
        };
    });
    const rejectCases = REJECT_CASES.map((entry) => {
        const assembled = assemble(entry.asm);
        if (assembled.tokens) {
            throw new Error(`${entry.name}: oracle accepted source expected to be rejected`);
        }
        return {
            name: entry.name,
            note: entry.note,
            asm: entry.asm,
            hr: '0x' + (assembled.hr >>> 0).toString(16),
        };
    });
    const acceptOnlyCases = ACCEPT_ONLY_CASES.map((entry) => {
        const assembled = assemble(entry.asm);
        if (!assembled.tokens) throw new Error(`${entry.name}: oracle refused the source: ${assembled.error}`);
        return {
            name: entry.name,
            note: entry.note,
            asm: entry.asm,
            tokens: [...assembled.tokens].map((t) => '0x' + t.toString(16).padStart(8, '0')),
        };
    });
    return {
        recordedFrom: process.env.BS_D3DX9 ?? 'C:\\Windows\\System32\\d3dx9_43.dll',
        generator: 'tools/gen-d3dx-shader-fixtures.ts',
        cases,
        rejectCases,
        acceptOnlyCases,
    };
}

const recorded = record();
const json = JSON.stringify(recorded, null, 2) + '\n';

if (process.argv.includes('--check')) {
    const existing = await Bun.file(OUTPUT).text();
    if (existing !== json) {
        console.error(`${OUTPUT} is stale — re-run bun tools/gen-d3dx-shader-fixtures.ts`);
        process.exit(1);
    }
    console.log(`${OUTPUT} matches the reference implementation`);
} else {
    await Bun.write(OUTPUT, json);
    console.log(`wrote ${OUTPUT} (${recorded.cases.length} cases, `
        + `${recorded.rejectCases.length} reject cases, ${recorded.acceptOnlyCases.length} accept-only cases)`);
}
