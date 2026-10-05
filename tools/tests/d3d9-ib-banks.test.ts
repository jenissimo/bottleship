import { describe, expect, test } from "bun:test";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import {
    emitUniformDeclarations,
    PS_PROGRAMMABLE_BIND_BYTES,
    SHADER_BOOLEAN_BANK_BYTES,
    SHADER_INTEGER_BANK_BYTES,
    VS_PROGRAMMABLE_BIND_BYTES,
} from "../../src/worker/backends/webgpu/d3d9/shader/link/uniforms";
import {
    D3D9StateBlockRecorder,
    applyStateBlockEntries,
    classifyStateBlockCoverage,
    refreshCapturedEntries,
    type StateBlockEntry,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { devices } from "../../src/worker/modules/d3d9/shared-state";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

describe("D3D9 SM3 integer/boolean banks", () => {
    test("emits c+i+b with fixed bank sizes and leaves hybrid FFP layout separate", () => {
        const programmableEmitter = new Emitter();
        emitUniformDeclarations(programmableEmitter, {
            vsBinding: 0,
            psBinding: 1,
            vsConstantCount: 257,
            psConstantCount: 2,
            hasPixelShader: true,
            usesLegacyBumpEnv: false,
            ffpStages: 8,
        });
        const linked = programmableEmitter.toString();
        const hybridEmitter = new Emitter();
        emitUniformDeclarations(hybridEmitter, {
            vsBinding: 0,
            psBinding: 1,
            vsConstantCount: 257,
            psConstantCount: 0,
            hasPixelShader: false,
            usesLegacyBumpEnv: false,
            ffpStages: 8,
        });
        const hybrid = hybridEmitter.toString();
        const legacyEmitter = new Emitter();
        emitUniformDeclarations(legacyEmitter, {
            vsBinding: 0,
            psBinding: 1,
            vsConstantCount: 257,
            psConstantCount: 224,
            hasPixelShader: true,
            usesLegacyBumpEnv: true,
            ffpStages: 8,
        });
        const legacy = legacyEmitter.toString();

        expect(linked).toContain("i: array<vec4<i32>, 16>");
        expect(linked).toContain("b: vec4<u32>");
        expect(linked).toContain("fn vsBool(n: u32)");
        expect(linked).toContain("fn psBool(n: u32)");
        expect(linked).not.toContain("psc.c[224");
        expect(hybrid).toContain("struct FfpStage");
        expect(hybrid).toContain("stageConstants: array<vec4<f32>, 8>");
        expect(hybrid).not.toContain("struct PsUniforms { c: array<vec4<f32>, 1>, i:");
        expect(legacy).toContain("b: vec4<u32>, bump: array<LegacyBumpStage, 8>");
        expect(legacy.match(/fn psBool/g)?.length).toBe(1);

        // VS's hidden pixel-centre c vec4 is included by the linker; the bind window is larger
        // than 4096 bytes even before that hidden vec4 is added by the executor.
        expect(VS_PROGRAMMABLE_BIND_BYTES).toBe(256 * 16 + SHADER_INTEGER_BANK_BYTES + SHADER_BOOLEAN_BANK_BYTES);
        // Legacy bump state (8 * 2 vec4) plus live programmable fog (color + params).
        expect(PS_PROGRAMMABLE_BIND_BYTES).toBe(224 * 16 + SHADER_INTEGER_BANK_BYTES + SHADER_BOOLEAN_BANK_BYTES + 8 * 2 * 16 + 2 * 16);
    });
});

describe("D3D9 I/B state-block seam", () => {
    test("records, replays, and refreshes all four I/B entry types", () => {
        const recorder = new D3D9StateBlockRecorder();
        recorder.begin();
        recorder.record({ op: "vertexShaderConstantI", start: 0, data: new Int32Array([4, -2, 0, 9]) });
        recorder.record({ op: "vertexShaderConstantB", start: 0, data: new Int32Array([1, 0]) });
        recorder.record({ op: "pixelShaderConstantI", start: 1, data: new Int32Array([7, 8, 9, 10]) });
        recorder.record({ op: "pixelShaderConstantB", start: 2, data: new Int32Array([1]) });
        const entries = recorder.end();

        expect(entries.map(entry => entry.op)).toEqual([
            "vertexShaderConstantI", "vertexShaderConstantB", "pixelShaderConstantI", "pixelShaderConstantB",
        ]);
        expect(classifyStateBlockCoverage(entries).coverable).toBe(false);

        const state = { vsI: new Int32Array(4), vsB: new Int32Array(2), psI: new Int32Array(8), psB: new Int32Array(3) };
        const fake = {
            setVertexShaderConstantIFromArray: (start: number, data: Int32Array) => { state.vsI.set(data, start * 4); return 0; },
            setVertexShaderConstantBFromArray: (start: number, data: Int32Array) => { state.vsB.set(data, start); return 0; },
            setPixelShaderConstantIFromArray: (start: number, data: Int32Array) => { state.psI.set(data, start * 4); return 0; },
            setPixelShaderConstantBFromArray: (start: number, data: Int32Array) => { state.psB.set(data, start); return 0; },
            getVertexShaderConstantsI: (start: number, count: number) => state.vsI.slice(start * 4, start * 4 + count * 4),
            getVertexShaderConstantsB: (start: number, count: number) => state.vsB.slice(start, start + count),
            getPixelShaderConstantsI: (start: number, count: number) => state.psI.slice(start * 4, start * 4 + count * 4),
            getPixelShaderConstantsB: (start: number, count: number) => state.psB.slice(start, start + count),
        };

        applyStateBlockEntries(fake as never, entries, new Uint8Array());
        expect([...state.vsI]).toEqual([4, -2, 0, 9]);
        expect([...state.vsB]).toEqual([1, 0]);
        expect([...state.psI]).toEqual([0, 0, 0, 0, 7, 8, 9, 10]);
        expect([...state.psB]).toEqual([0, 0, 1]);

        state.vsI[0] = -99;
        state.vsB[0] = 0;
        state.psI[4] = -77;
        state.psB[2] = 0;
        refreshCapturedEntries(fake as never, entries);
        expect((entries[0] as Extract<StateBlockEntry, { op: "vertexShaderConstantI" }>).data[0]).toBe(-99);
        expect((entries[1] as Extract<StateBlockEntry, { op: "vertexShaderConstantB" }>).data[0]).toBe(0);
        expect((entries[2] as Extract<StateBlockEntry, { op: "pixelShaderConstantI" }>).data[0]).toBe(-77);
        expect((entries[3] as Extract<StateBlockEntry, { op: "pixelShaderConstantB" }>).data[0]).toBe(0);
    });
});

describe("D3D9 I/B getter ABI", () => {
    test("writes VS/PS integer lanes and normalized boolean values to out params", () => {
        const devicePtr = 0x2a;
        const fake = {
            getVertexShaderConstantsI: (start: number, count: number) => new Int32Array([-7, 8, 9, 10]).slice(start * 4, start * 4 + count * 4),
            getVertexShaderConstantsB: (start: number, count: number) => new Int32Array([0, 1]).slice(start, start + count),
            getPixelShaderConstantsI: (start: number, count: number) => new Int32Array([11, -12, 13, 14]).slice(start * 4, start * 4 + count * 4),
            getPixelShaderConstantsB: (start: number, count: number) => new Int32Array([1, 0]).slice(start, start + count),
        };
        devices.set(devicePtr, fake as never);

        const writes = new Map<number, number>();
        const originalWriteUint32 = Mem.writeUint32;
        (Mem as unknown as { writeUint32: (address: number, value: number) => boolean }).writeUint32 = (address, value) => {
            writes.set(address, value >>> 0);
            return true;
        };

        try {
            const exports = createStateExports();
            const mem = new Uint8Array();
            expect(exports["IDirect3DDevice9_GetVertexShaderConstantI"]!(null, mem, [devicePtr, 0, 0x100, 1])).toBe(0);
            expect(exports["IDirect3DDevice9_GetVertexShaderConstantB"]!(null, mem, [devicePtr, 0, 0x200, 2])).toBe(0);
            expect(exports["IDirect3DDevice9_GetPixelShaderConstantI"]!(null, mem, [devicePtr, 0, 0x300, 1])).toBe(0);
            expect(exports["IDirect3DDevice9_GetPixelShaderConstantB"]!(null, mem, [devicePtr, 0, 0x400, 2])).toBe(0);
        } finally {
            (Mem as unknown as { writeUint32: typeof Mem.writeUint32 }).writeUint32 = originalWriteUint32;
            devices.delete(devicePtr);
        }

        expect(writes.get(0x100)).toBe((-7) >>> 0);
        expect(writes.get(0x104)).toBe(8);
        expect(writes.get(0x108)).toBe(9);
        expect(writes.get(0x10c)).toBe(10);
        expect(writes.get(0x200)).toBe(0);
        expect(writes.get(0x204)).toBe(1);
        expect(writes.get(0x300)).toBe(11);
        expect(writes.get(0x304)).toBe((-12) >>> 0);
        expect(writes.get(0x308)).toBe(13);
        expect(writes.get(0x30c)).toBe(14);
        expect(writes.get(0x400)).toBe(1);
        expect(writes.get(0x404)).toBe(0);
    });
});
