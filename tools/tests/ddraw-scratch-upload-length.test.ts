import { describe, expect, it } from 'bun:test';
import { VertexConverter } from '../../src/worker/backends/webgpu/ddraw/compute/vertex-converter';
import { GeometryUploadWindow } from '../../src/worker/backends/webgpu/ddraw/geometry-upload-window';
import { DDrawWebGPUExecutor as DDrawBackendExecutor } from '../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor';
import { RingBufferManager } from '../../src/worker/backends/webgpu/ddraw/ring-buffer-manager';
import { D3DFVF_DIFFUSE, D3DFVF_XYZRHW } from '../../src/worker/modules/ddraw/constants';

type Any = Record<string, any>;

describe('CPU geometry upload length', () => {
    it('uploads only the converted vertices, not the scratch capacity', () => {
        const fvf = D3DFVF_XYZRHW | D3DFVF_DIFFUSE | 0x100;
        const converter = Object.create(VertexConverter.prototype) as Any;
        Object.assign(converter, { formatCache: new Map(), isLittleEndian: true });
        const exec = Object.assign(Object.create(DDrawBackendExecutor.prototype), { scratchBuffer: null, scratchBufferSize: 0 }) as Any;
        exec.initScratchBuffer();
        const window = new GeometryUploadWindow();
        const ring = Object.assign(Object.create(RingBufferManager.prototype), {
            currentFrameIndex: 0, vertexRingOffsets: [0], vertexRingSizes: [4 << 20], vertexRingBuffers: [{}],
            maxRingBufferSize: 4 << 20, lastVertexWarnBucket: 0, geometryStagingEnabled: true, vertexUploadWindows: [window],
        }) as Any;
        const memory = new Uint8Array(128 * 1024);
        const view = new DataView(memory.buffer);
        for (let i = 0; i < 1024; i++) {
            const b = i * 28;
            view.setFloat32(b, 50 + (i % 100), true); view.setFloat32(b + 4, 50 + (i % 80), true);
            view.setFloat32(b + 8, 0.5, true); view.setFloat32(b + 12, 1, true);
            view.setUint32(b + 16, 0xffa0b0c0, true); view.setFloat32(b + 20, 0.25, true); view.setFloat32(b + 24, 0.75, true);
        }
        const uploads: number[] = [];
        for (const count of [3, 1024, 3, 4, 12, 1]) {
            const wanted = count * 64;
            const out = converter.convertSync(memory, 0, count, fvf, exec.ensureScratchBuffer(wanted), 800, 600) as Uint8Array;
            const exact = converter.convertSync(memory, 0, count, fvf, undefined, 800, 600) as Uint8Array;
            expect(out.byteLength).toBe(wanted);
            expect(Array.from(out)).toEqual(Array.from(exact));
            const before = ring.vertexRingOffsets[0];
            ring.allocateVertexData(out);
            expect(ring.vertexRingOffsets[0] - before).toBe(wanted);
            window.flush({ writeBuffer: (_b: unknown, _o: number, _d: unknown, _s: number, size: number) => uploads.push(size) } as never, ring.vertexRingBuffers[0], ring.vertexRingOffsets[0]);
            expect(uploads.at(-1)).toBe(wanted);
        }
        expect(exec.scratchBufferSize).toBeGreaterThanOrEqual(65536);
    });
});
