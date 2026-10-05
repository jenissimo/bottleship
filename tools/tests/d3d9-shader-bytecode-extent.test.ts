/**
 * Where a D3D9 shader ENDS.
 *
 * Bytecode has no length prefix, so the runtime walks to the END token — and the walk has to
 * skip comment blocks, because a comment payload is arbitrary binary. A CTAB carries constant
 * NAMES and float defaults, and those bytes routinely contain a dword whose low half is
 * 0xFFFF. Scanning for "low half == 0xFFFF" therefore stops inside the CTAB of ordinary
 * shaders; the truncated stream is then refused as "unterminated bytecode", which reads as a
 * broken asset rather than as a short read. In RA3 that silently dropped the terrain and unit
 * shaders: the pass bound shader 0 and the draws fell back to the fixed function.
 *
 * Ground truth: D3DXGetShaderSize, Wine dlls/d3dx9_36/shader.c.
 */
import { describe, expect, test } from "bun:test";
import { d3dShaderTokenCount } from "../../src/worker/backends/webgpu/d3d9/shader/bytecode-extent";

const VS_3_0 = 0xfffe0300;
const PS_3_0 = 0xffff0300;
const END = 0x0000ffff;
const comment = (dwords: number) => (0x0000fffe | (dwords << 16)) >>> 0;

const walk = (tokens: number[]) =>
    d3dShaderTokenCount((i) => tokens[i] ?? 0, tokens.length);

describe("d3dShaderTokenCount", () => {
    test("counts version + body + END", () => {
        expect(walk([VS_3_0, 0x02000001, 0x800f0000, 0x90e40000, END])).toBe(5);
    });

    test("a comment payload is skipped, not scanned", () => {
        // The payload's second dword ends in 0xFFFF — the exact shape that truncated RA3's
        // shaders. The real END sits after the comment.
        const tokens = [VS_3_0, comment(3), 0x11223344, 0xdead_ffff >>> 0, 0x55667788,
                        0x02000001, END];
        expect(walk(tokens)).toBe(7);
    });

    test("a payload dword equal to END itself does not terminate the walk", () => {
        const tokens = [PS_3_0, comment(2), END, 0x00000000, 0x02000001, END];
        expect(walk(tokens)).toBe(6);
    });

    test("back-to-back comments each advance by their own length", () => {
        const tokens = [PS_3_0, comment(1), 0xffffffff, comment(2), 0x0000ffff, 0xffff0000, END];
        expect(walk(tokens)).toBe(7);
    });

    test("a stream with no END is reported as such, never as a short prefix", () => {
        expect(walk([VS_3_0, 0x02000001, 0x800f0000])).toBeNull();
    });

    test("a comment claiming more than the limit does not run off the end", () => {
        expect(walk([VS_3_0, comment(9999), 0x11223344])).toBeNull();
    });

    test("the version token is never mistaken for a comment", () => {
        // vs_3_0 masked with the opcode mask is 0x0300, but a version token that happened to
        // alias D3DSIO_COMMENT would skip real instructions if the walk inspected it.
        expect(walk([VS_3_0, END])).toBe(2);
    });
});
