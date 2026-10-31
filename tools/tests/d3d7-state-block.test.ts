/**
 * IDirect3DDevice7 Begin/EndStateBlock: Set* calls while recording go into the block, not
 * the device, and ApplyStateBlock replays only the states that were recorded. Applying a
 * whole zero-filled snapshot instead wipes every render/stage state and texture binding.
 */
import { describe, expect, test } from "bun:test";
import { SystemResourceProvider } from "../../src/worker/core/resources/system-resource-provider";
import { BaseComObject } from "../../src/worker/core/com/base-com-object";
import { Direct3DDevice7Object } from "../../src/worker/modules/ddraw/com-objects";
import {
    D3DRENDERSTATE_ALPHABLENDENABLE, D3DRENDERSTATE_LIGHTING, D3DRENDERSTATE_ZENABLE, D3DTSS_COLOROP,
} from "../../src/worker/modules/ddraw/constants";
import { createDeviceExports } from "../../src/worker/modules/ddraw/d3d/device-impl";

const DEVICE = 0x100, OUT = 0x300;
const TEX_A = 0x5000, TEX_B = 0x6000;
const D3DTOP_MODULATE = 4, D3DTOP_SELECTARG1 = 2;

function setup() {
    const rp = SystemResourceProvider.getInstance();
    const device = new Direct3DDevice7Object(0);
    rp.mapAddressToHandle(DEVICE, device.handle);
    const textureManager = {
        setDeviceTexture: (dev: Direct3DDevice7Object, stage: number, tex: number) => dev.setTexture(stage, tex),
        resolve: (addr: number) => ({ addr, obj: null, source: "test" }),
    };
    const exports = createDeviceExports({ resourceProvider: rp } as never, textureManager as never, {} as never);
    const mem = new Uint8Array(0x1000);
    const call = (name: string, ...args: number[]) =>
        exports[`IDirect3DDevice7_${name}`]!(null as never, mem, [DEVICE, ...args]);
    return { device, call, view: new DataView(mem.buffer) };
}

function record(call: ReturnType<typeof setup>["call"], view: DataView, body: () => void): number {
    expect(call("BeginStateBlock")).toBe(0);
    body();
    expect(call("EndStateBlock", OUT)).toBe(0);
    return view.getUint32(OUT, true);
}

class TestTexture extends BaseComObject {
    destroyed = false;
    constructor() { super("test-texture", 0); }
    protected destroy(): void { this.destroyed = true; }
}

describe("IDirect3DDevice7 recorded state blocks", () => {
    test("recorded texture survives release until its state block is deleted", () => {
        const rp = SystemResourceProvider.getInstance();
        const device = new Direct3DDevice7Object(0);
        const texture = new TestTexture();
        const address = 0x7010;
        rp.mapAddressToHandle(address, texture.handle);
        device.beginStateBlock();
        device.setTexture(0, address);
        expect(texture.refCount).toBe(2);
        const block = device.endStateBlock();
        texture.release();
        expect(texture.destroyed).toBe(false);
        expect(device.applyStateBlock(block)?.textures[0]).toBe(address);
        expect(device.deleteStateBlock(block)).toBe(true);
        expect(texture.destroyed).toBe(true);
        device.release();
    });

    test("capture replaces the state block's retained texture", () => {
        const rp = SystemResourceProvider.getInstance();
        const device = new Direct3DDevice7Object(0);
        const first = new TestTexture(), second = new TestTexture();
        rp.mapAddressToHandle(0x7020, first.handle);
        rp.mapAddressToHandle(0x7030, second.handle);
        device.beginStateBlock();
        device.setTexture(0, 0x7020);
        const block = device.endStateBlock();
        device.setTexture(0, 0x7030);
        expect(device.captureStateBlock(block)).toBe(true);
        expect(first.refCount).toBe(1);
        expect(second.refCount).toBe(2);
        device.deleteStateBlock(block);
        expect(second.refCount).toBe(1);
        device.unbindTexture(0);
        first.release(); second.release(); device.release();
    });
    test("Set* while recording does not touch the device", () => {
        const { device, call, view } = setup();
        call("SetRenderState", D3DRENDERSTATE_ZENABLE, 1);
        record(call, view, () => {
            call("SetRenderState", D3DRENDERSTATE_ZENABLE, 0);
            call("SetTexture", 0, TEX_A);
            call("SetTextureStageState", 0, D3DTSS_COLOROP, D3DTOP_SELECTARG1);
        });
        expect(device.getRenderState(D3DRENDERSTATE_ZENABLE)).toBe(1);
        expect(device.getTexture(0)).toBe(0);
    });

    test("Apply replays only the recorded states and leaves the rest alone", () => {
        const { device, call, view } = setup();
        const handle = record(call, view, () => {
            call("SetRenderState", D3DRENDERSTATE_ALPHABLENDENABLE, 1);
            call("SetTexture", 0, TEX_A);
            call("SetTextureStageState", 0, D3DTSS_COLOROP, D3DTOP_MODULATE);
        });
        call("SetRenderState", D3DRENDERSTATE_ZENABLE, 1);
        call("SetRenderState", D3DRENDERSTATE_LIGHTING, 0);
        call("SetTexture", 1, TEX_B);

        expect(call("ApplyStateBlock", handle)).toBe(0);
        expect(device.getRenderState(D3DRENDERSTATE_ALPHABLENDENABLE)).toBe(1);
        expect(device.getTexture(0)).toBe(TEX_A);
        expect(device.getTextureStageState(0, D3DTSS_COLOROP)).toBe(D3DTOP_MODULATE);
        expect(device.getRenderState(D3DRENDERSTATE_ZENABLE)).toBe(1);
        expect(device.getRenderState(D3DRENDERSTATE_LIGHTING)).toBe(0);
        expect(device.getTexture(1)).toBe(TEX_B);
    });

    test("Capture refreshes only the recorded states", () => {
        const { device, call, view } = setup();
        const handle = record(call, view, () => call("SetRenderState", D3DRENDERSTATE_ALPHABLENDENABLE, 1));
        call("SetRenderState", D3DRENDERSTATE_ALPHABLENDENABLE, 0);
        call("SetRenderState", D3DRENDERSTATE_ZENABLE, 1);
        expect(call("CaptureStateBlock", handle)).toBe(0);

        call("SetRenderState", D3DRENDERSTATE_ALPHABLENDENABLE, 1);
        call("SetRenderState", D3DRENDERSTATE_ZENABLE, 0);
        call("ApplyStateBlock", handle);
        expect(device.getRenderState(D3DRENDERSTATE_ALPHABLENDENABLE)).toBe(0);
        expect(device.getRenderState(D3DRENDERSTATE_ZENABLE)).toBe(0);
    });
});
