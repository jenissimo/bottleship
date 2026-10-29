import { describe, expect, test } from "bun:test";
import {
    createExeDecoder, InnoExeDecoder4108, InnoExeDecoder5200, type InnoExeDecoder,
} from "../../packages/formats/src/inno/exe-filter";
import { InnoVersion, INNO_VERSION, assertSupportedVersion, parseVersionString } from "../../packages/formats/src/inno/version";

/** Inno's pre-5.2.0 encoder: an E8/E9 operand is stored as rel + (offset of the opcode + 5). */
function encode4108(code: Uint8Array): Uint8Array {
    const out = code.slice();
    for (let i = 0; i + 4 < out.length; i++) {
        if (out[i] !== 0xe8 && out[i] !== 0xe9) continue;
        const view = new DataView(out.buffer, i + 1, 4);
        view.setUint32(0, (view.getUint32(0, true) + i + 5) >>> 0, true);
        i += 4;
    }
    return out;
}

function decodeInChunks(dec: InnoExeDecoder, data: Uint8Array, chunk: number): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += chunk) parts.push(dec.push(data.subarray(i, i + chunk)));
    parts.push(dec.finish());
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

describe("Inno call/jmp filter", () => {
    const code = new Uint8Array([
        0x55, 0xe8, 0x10, 0x00, 0x00, 0x00, 0x90, 0xe9, 0xf0, 0xff, 0xff, 0xff,
        0x8b, 0xec, 0xe8, 0x00, 0x00, 0x00, 0x80, 0xc3, 0xe8, 0x01, 0x02, 0x03, 0x04,
    ]);

    test("4108 undoes the pre-5.2.0 encoding, whatever the chunking", () => {
        const stored = encode4108(code);
        expect(Array.from(stored)).not.toEqual(Array.from(code));
        for (const chunk of [1, 2, 3, 5, 7, code.length]) {
            expect(Array.from(decodeInChunks(new InnoExeDecoder4108(), stored, chunk))).toEqual(Array.from(code));
        }
    });

    test("the installer's version picks the filter", () => {
        expect(createExeDecoder(new InnoVersion(INNO_VERSION(5, 1, 10)))).toBeInstanceOf(InnoExeDecoder4108);
        expect(createExeDecoder(new InnoVersion(INNO_VERSION(5, 2, 0)))).toBeInstanceOf(InnoExeDecoder5200);
        expect(createExeDecoder(new InnoVersion(INNO_VERSION(5, 3, 9)))).toBeInstanceOf(InnoExeDecoder5200);
    });

    test("5.1 setup data is accepted and 5.0 is not", () => {
        const header = (s: string) => { const b = new Uint8Array(64); b.set(new TextEncoder().encode(s)); return b; };
        expect(() => assertSupportedVersion(parseVersionString(header("Inno Setup Setup Data (5.1.0)")))).not.toThrow();
        expect(() => assertSupportedVersion(parseVersionString(header("Inno Setup Setup Data (5.1.13)")))).not.toThrow();
        expect(() => assertSupportedVersion(parseVersionString(header("Inno Setup Setup Data (5.0.8)")))).toThrow();
    });
});
