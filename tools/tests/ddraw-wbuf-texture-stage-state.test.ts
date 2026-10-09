/**
 * The write-buffer SetTextureStageState handlers (D3D3, D3D7) must leave a device in the same
 * state as the slow-path export, which calls the device's setTextureStageState. D3DTSS_ADDRESS
 * is the case that diverged: it sets ADDRESSU and ADDRESSV too, and a raw store of slot 12
 * left both at WRAP — a CLAMP-addressed tile then blends its opposite edge in as a seam.
 */
import { describe, expect, test } from "bun:test";
import { registerFastPathD3DFunctions } from "../../src/worker/modules/ddraw/d3d/index";
import { Direct3DDevice3Object, Direct3DDevice7Object } from "../../src/worker/modules/ddraw/com-objects";
import { D3DTSS_ADDRESS, D3DTSS_ADDRESSU, D3DTSS_ADDRESSV } from "../../src/worker/modules/ddraw/d3d/sampler-constants";

type RingHandler = (mem8: Uint8Array, mem32: Uint32Array, ptr: number) => void;
const DEVICE = 0x5fb00d90;
const CLAMP = 3, MIRROR = 2;

function handlersFor(device: unknown): Map<string, RingHandler> {
    const handlers = new Map<string, RingHandler>();
    const dispatcher = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => {
            if (prop === "registerWriteBufferFunction") {
                return (_dll: string, name: string, _argc: number, fn: RingHandler) => { handlers.set(name, fn); };
            }
            return typeof prop === "string" && prop.startsWith("register") ? () => undefined : undefined;
        },
    });
    const context = { resourceProvider: { getComObjectByAddress: (a: number) => (a === DEVICE ? device : null) } };
    registerFastPathD3DFunctions(dispatcher as never, context as never);
    return handlers;
}

/** One ring entry (thisPtr, stage, type, value) at offset 0, as the guest stub writes it. */
function entry(stage: number, type: number, value: number) {
    const u32 = Uint32Array.of(DEVICE, stage >>> 0, type >>> 0, value >>> 0);
    return { u8: new Uint8Array(u32.buffer), u32 };
}

const CALLS: Array<[number, number, number]> = [
    [0, D3DTSS_ADDRESS, CLAMP],
    [1, D3DTSS_ADDRESSU, MIRROR],
    [1, D3DTSS_ADDRESS, CLAMP],
    [2, D3DTSS_ADDRESSV, CLAMP],
    [0, 1, 4],          // COLOROP = MODULATE
    [0, 40, 7],         // type out of range: ignored, not stage 1's slot 8
    [9, 1, 7],          // stage out of range: ignored
    [7, 31, 5],
];

describe("write-buffer SetTextureStageState matches the slow path", () => {
    for (const [name, Device] of [
        ["IDirect3DDevice7_SetTextureStageState", Direct3DDevice7Object],
        ["IDirect3DDevice3_SetTextureStageState", Direct3DDevice3Object],
    ] as const) {
        test(name, () => {
            const fast = new Device(0), slow = new Device(0);
            const handler = handlersFor(fast).get(name)!;
            expect(handler).toBeDefined();
            for (const [stage, type, value] of CALLS) {
                const { u8, u32 } = entry(stage, type, value);
                handler(u8, u32, 0);
                slow.setTextureStageState(stage, type, value);
            }
            expect(Array.from(fast.getAllTextureStageStates())).toEqual(Array.from(slow.getAllTextureStageStates()));

            const tss = fast.getAllTextureStageStates();
            expect([tss[D3DTSS_ADDRESSU], tss[D3DTSS_ADDRESSV]]).toEqual([CLAMP, CLAMP]);
            expect([tss[32 + D3DTSS_ADDRESSU], tss[32 + D3DTSS_ADDRESSV]]).toEqual([CLAMP, CLAMP]);
            expect(tss[32 + 8]).not.toBe(7);
            expect(tss[2 * 32 + D3DTSS_ADDRESSU]).not.toBe(CLAMP);
        });
    }
});
