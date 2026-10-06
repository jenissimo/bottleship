import { describe, expect, spyOn, test } from "bun:test";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";
import { System } from "../../src/worker/core/system";
import { TextureConverter } from "../../src/worker/backends/webgpu/shared/texture-converter";

describe("palette presentation GPU buffer lifetime", () => {
    for (const pendingDraw of [false, true]) {
        test(`repeated uploads retire buffers after submit (pending draw: ${pendingDraw})`, () => {
            const globals = globalThis as any;
            const oldUsage = globals.GPUBufferUsage;
            const oldStage = globals.GPUShaderStage;
            const oldSystem = globals.System;
            globals.System = System;
            globals.GPUBufferUsage = { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
            globals.GPUShaderStage = { COMPUTE: 4 };
            const buffers: Array<{ destroyed: boolean; destroy(): void }> = [];
            let submitted = 0;
            const queue = {
                writeBuffer() {},
                submit(commands: any[]) {
                    for (const command of commands) {
                        for (const buffer of command.buffers) expect(buffer.destroyed).toBe(false);
                        submitted++;
                    }
                },
            };
            const device = {
                createBuffer() {
                    const buffer = { destroyed: false, destroy() { this.destroyed = true; } };
                    buffers.push(buffer);
                    return buffer;
                },
                createBindGroupLayout() { return {}; },
                createPipelineLayout() { return {}; },
                createShaderModule() { return {}; },
                createComputePipeline() { return {}; },
                createBindGroup(desc: any) { return desc; },
                createCommandEncoder() {
                    const referenced = new Set<unknown>();
                    return {
                        beginComputePass() {
                            return {
                                setPipeline() {},
                                setBindGroup(_: number, group: any) {
                                    for (const entry of group.entries) referenced.add(entry.resource.buffer);
                                },
                                dispatchWorkgroups() {}, end() {},
                            };
                        },
                        copyBufferToTexture(src: any) { referenced.add(src.buffer); },
                        finish() { return { buffers: referenced }; },
                    };
                },
            };
            const converter = new TextureConverter(device as any, queue as any);
            let pending: any;
            const executor = {
                getTextureConverter: () => converter,
                flush() {
                    if (!pending) return;
                    queue.submit([pending.finish()]);
                    pending = null;
                    converter.destroyPendingAfterSubmit();
                },
            };
            const system = {
                process: { getModule: () => ({ context: { executor } }) },
                resourceProvider: { getComObject: () => ({ getEntries: () => new Uint32Array(256) }) },
            };
            const systemSpy = spyOn(System, "getInstance").mockReturnValue(system as any);
            try {
                const texture = { width: 64, height: 64 };
                const surface = {
                    surfaceType: "render_surface", width: 64, height: 64, pitch: 64,
                    surfacePtr: 4, paletteHandle: 1, version: 1, gpuDirty: true,
                    format: { bpp: 8, flags: 0x20, rMask: 0, gMask: 0, bMask: 0, aMask: 0 },
                    gpuTexture: texture, gpuTextureFormat: "rgba8unorm",
                };
                const memory = new Uint8Array(64 * 64 + 4);
                const presenter = Object.create(DDrawPresenter.prototype) as any;
                for (let frame = 0; frame < 120; frame++) {
                    if (pendingDraw) {
                        pending = device.createCommandEncoder();
                        converter.convertToTexture(pending, memory, 4, 64, 64, 64,
                            surface.format as any, texture as any, undefined, "rgba8unorm", new Uint32Array(256));
                    }
                    presenter.uploadPalette8SurfaceToGPU(surface, memory, device, queue);
                    // Only the three immutable format LUTs may survive the submission.
                    expect(buffers.filter(buffer => !buffer.destroyed).length).toBe(3);
                }
                expect(submitted).toBe(pendingDraw ? 240 : 120);
            } finally {
                converter.destroy();
                systemSpy.mockRestore();
                if (oldUsage === undefined) delete globals.GPUBufferUsage;
                else globals.GPUBufferUsage = oldUsage;
                if (oldStage === undefined) delete globals.GPUShaderStage;
                else globals.GPUShaderStage = oldStage;
                if (oldSystem === undefined) delete globals.System;
                else globals.System = oldSystem;
            }
        });
    }
});
