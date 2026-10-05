import { afterEach, describe, expect, test } from "bun:test";
import { probeD3D9WebGpuCapabilities } from "../../src/worker/backends/webgpu/shared/capability-probe";
import {
    getD3D9FloatCapabilityContract,
    resolveD3D9FloatTexturePolicy,
    setD3D9FloatCapabilityContract,
} from "../../src/worker/backends/webgpu/shared/float-format-policy";
import {
    getD3D9MsaaCapabilityContract,
    setD3D9MsaaCapabilityContract,
} from "../../src/worker/backends/webgpu/d3d9/multisample";
import {
    getD3D9VolumeCapabilityContract,
    resolveD3D9VolumePolicy,
    setD3D9VolumeCapabilityContract,
} from "../../src/worker/backends/webgpu/shared/volume-policy";
import {
    getD3D9WebGpuCapabilityLimits,
    setD3D9WebGpuCapabilityLimits,
} from "../../src/worker/backends/webgpu/shared/webgpu-capability-limits";
import {
    checkDxDeviceFormat,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

class FakeTexture {
    createView(_descriptor?: unknown): GPUTextureView { return {} as GPUTextureView; }
    destroy(): void {}
}

class FakeBuffer {
    constructor(private readonly rejectMapping = false) {}
    async mapAsync(_mode: number): Promise<void> {
        if (this.rejectMapping) throw new Error("mapAsync rejected");
    }
    getMappedRange(): ArrayBuffer {
        const mapped = new Uint8Array(256);
        for (let i = 0; i < mapped.length; i++) mapped[i] = (i + 1) & 0xff;
        return mapped.buffer;
    }
    unmap(): void {}
    destroy(): void {}
}

class FakePipeline {
    constructor(readonly requiresBindGroup: boolean, readonly multisample: boolean) {}
    getBindGroupLayout(_index: number): GPUBindGroupLayout { return {} as GPUBindGroupLayout; }
}

/**
 * A pass that models the one precondition this probe exists to check: WebGPU raises a
 * validation error when a draw runs a pipeline whose layout has bindings and no bind
 * group was set. Without it, a probe that never sets one still reads as "supported".
 */
class FakePass {
    private pipeline: FakePipeline | null = null;
    private boundGroups = new Set<number>();
    constructor(private readonly markError: (message: string) => void) {}
    setPipeline(pipeline: GPURenderPipeline): void {
        this.pipeline = pipeline as unknown as FakePipeline;
        this.boundGroups.clear();
    }
    setBindGroup(index: number, _group: GPUBindGroup): void { this.boundGroups.add(index); }
    draw(_count: number): void {
        if (!this.pipeline) {
            this.markError("draw without a pipeline");
            return;
        }
        if (this.pipeline.requiresBindGroup && !this.boundGroups.has(0)) {
            this.markError("bind group 0 is required by the pipeline layout but was never set");
        }
    }
    end(): void {}
}

class FakeEncoder {
    constructor(private readonly markError: (message: string) => void) {}
    copyTextureToBuffer(..._args: unknown[]): void {}
    beginRenderPass(_descriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        return new FakePass(this.markError) as unknown as GPURenderPassEncoder;
    }
    finish(): GPUCommandBuffer { return {} as GPUCommandBuffer; }
}

/** WGSL declaring a resource binding needs a bind group before any draw using it. */
function declaresBindings(module: GPUShaderModule): boolean {
    return (module as unknown as { code?: string }).code?.includes("@group(") === true;
}

class FakeGpuDevice {
    readonly limits = {
        maxTextureDimension2D: 8192,
        maxTextureDimension3D: 512,
    } as GPUSupportedLimits;
    readonly queue = {
        writeTexture: (..._args: unknown[]) => undefined,
        submit: (..._args: unknown[]) => undefined,
        onSubmittedWorkDone: async () => undefined,
    } as unknown as GPUQueue;
    private readonly errors: (GPUError | null)[] = [];

    constructor(
        private readonly rejectTwoSample = true,
        private readonly rejectSampling = false,
        private readonly rejectReadback = false,
    ) {}

    pushErrorScope(_filter: GPUErrorFilter): void { this.errors.push(null); }

    async popErrorScope(): Promise<GPUError | null> { return this.errors.pop() ?? null; }

    private markError(message: string): void {
        const index = this.errors.length - 1;
        if (index >= 0 && !this.errors[index]) this.errors[index] = { message } as GPUValidationError;
    }

    createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
        if (this.rejectTwoSample && descriptor.sampleCount === 2) this.markError("two-sample attachments are unsupported");
        return new FakeTexture() as unknown as GPUTexture;
    }

    createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
        return {
            code: descriptor.code,
            getCompilationInfo: async () => ({ messages: [] }),
        } as unknown as GPUShaderModule;
    }

    createSampler(_descriptor: GPUSamplerDescriptor): GPUSampler { return {} as GPUSampler; }

    createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
        // The sampling probe uses a single-sample pipeline; the MSAA probe also
        // creates a pipeline, but that path must remain accepted in this case.
        if (this.rejectSampling && !descriptor.multisample) this.markError("sampling pipeline rejected");
        const requiresBindGroup = declaresBindings(descriptor.vertex.module) ||
            (descriptor.fragment !== undefined && declaresBindings(descriptor.fragment.module));
        return new FakePipeline(requiresBindGroup, descriptor.multisample !== undefined) as unknown as GPURenderPipeline;
    }

    createBindGroup(_descriptor: GPUBindGroupDescriptor): GPUBindGroup { return {} as GPUBindGroup; }
    createCommandEncoder(): GPUCommandEncoder {
        return new FakeEncoder(message => this.markError(message)) as unknown as GPUCommandEncoder;
    }
    createBuffer(_descriptor: GPUBufferDescriptor): GPUBuffer {
        return new FakeBuffer(this.rejectReadback) as unknown as GPUBuffer;
    }
}

afterEach(() => {
    setD3D9MsaaCapabilityContract(null);
    setD3D9FloatCapabilityContract(null);
    setD3D9VolumeCapabilityContract(null);
    setD3D9WebGpuCapabilityLimits(null);
});

describe("live D3D9 WebGPU capability probe", () => {
    test("publishes only capabilities accepted by attachment, upload, sampling and readback probes", async () => {
        await probeD3D9WebGpuCapabilities(new FakeGpuDevice() as unknown as GPUDevice);

        expect(getD3D9MsaaCapabilityContract()?.supportsSampleCount(2)).toBe(false);
        expect(getD3D9MsaaCapabilityContract()?.supportsSampleCount(4)).toBe(true);
        expect(resolveD3D9FloatTexturePolicy(111).supported).toBe(true);
        expect(resolveD3D9VolumePolicy(9, 21).supported).toBe(true);
        // The 3-D probe measures one generic rgba8unorm path, and every volume format
        // reaches it through the same CPU decode. Advertising ARGB8 alone refused the
        // X8R8G8B8/L8/DXT volume LUTs that era hardware and DXVK accept.
        for (const format of [22, 50, 51, 0x31545844, 0x35545844]) {
            expect(resolveD3D9VolumePolicy(9, format).supported).toBe(true);
        }
        // Formats the 3-D upload path cannot carry faithfully stay refused.
        for (const format of [41, 114, 117]) {
            expect(resolveD3D9VolumePolicy(9, format).supported).toBe(false);
        }
        // The public CheckDeviceFormat answer moves with the contract: an X8R8G8B8
        // volume LUT is the common case, and refusing it sent titles to a 2-D fallback.
        expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 4, 22)).toBe(D3D_OK);
        expect(checkDxDeviceFormat(9, 0, 1, 22, 0, 4, 41 /* P8 */)).toBe(D3DERR_NOTAVAILABLE);
        expect(getD3D9WebGpuCapabilityLimits()).toEqual({
            maxTextureDimension2D: 8192,
            maxTextureDimension3D: 512,
        });
    });

    test("a sampling validation failure is a hard capability refusal", async () => {
        await probeD3D9WebGpuCapabilities(new FakeGpuDevice(true, true) as unknown as GPUDevice);

        expect(getD3D9MsaaCapabilityContract()?.supportsSampleCount(4)).toBe(true);
        expect(getD3D9FloatCapabilityContract()).not.toBeNull();
        expect(resolveD3D9FloatTexturePolicy(111).supported).toBe(false);
        expect(getD3D9VolumeCapabilityContract()).toBeNull();
        expect(resolveD3D9VolumePolicy(9, 21).supported).toBe(false);
    });

    test("a readback mapping failure is a hard capability refusal", async () => {
        await probeD3D9WebGpuCapabilities(new FakeGpuDevice(false, false, true) as unknown as GPUDevice);

        expect(getD3D9FloatCapabilityContract()).not.toBeNull();
        expect(resolveD3D9FloatTexturePolicy(111).supported).toBe(false);
        expect(getD3D9VolumeCapabilityContract()).toBeNull();
        expect(resolveD3D9VolumePolicy(9, 21).supported).toBe(false);
    });

    test("a stale device probe cannot publish contracts after loss", async () => {
        setD3D9WebGpuCapabilityLimits(null);
        await probeD3D9WebGpuCapabilities(new FakeGpuDevice() as unknown as GPUDevice, () => false);
        expect(getD3D9MsaaCapabilityContract()).toBeNull();
        expect(getD3D9FloatCapabilityContract()).toBeNull();
        expect(getD3D9VolumeCapabilityContract()).toBeNull();
        expect(getD3D9WebGpuCapabilityLimits()).toBeNull();
    });
});
