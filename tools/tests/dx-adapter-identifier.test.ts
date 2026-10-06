import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { EmulatorConfig } from '../../src/worker/core/emulator-config-manager';
import { normalizeGraphicsAdapter, type GraphicsAdapterConfig } from '../../src/worker/core/graphics-adapter-config';
import {
    D3DADAPTER_IDENTIFIER8_SIZE,
    D3DADAPTER_IDENTIFIER9_OFFSETS,
    D3DADAPTER_IDENTIFIER9_SIZE,
    DEFAULT_DEVICE_ID,
    DEFAULT_DRIVER_DLL,
    DEFAULT_VENDOR_ID,
    writeAdapterIdentifier6,
    writeAdapterIdentifier8,
    writeAdapterIdentifier9,
} from '../../src/worker/backends/webgpu/shared/dx-adapter-identifier';

const adapter: GraphicsAdapterConfig = {
    vendorId: 0x1002, deviceId: 0x73bf, description: 'AMD Radeon RX 6900 XT',
    driver: 'aticfx32.dll', driverVersion: [31, 0, 24033, 1003],
};
const cfg = EmulatorConfig.getInstance();
beforeEach(() => cfg.reset());
afterEach(() => cfg.reset());
function apply(value: GraphicsAdapterConfig) {
    cfg.applyFromManifest({ formatVersion: 2, name: 'test', entrypoint: 'rom/test.exe', emulator: { graphicsAdapter: value } });
}

describe('dx-adapter-identifier', () => {
    test('DX6, DX8 and DX9 expose the complete manifest identity and respect ABI extents', () => {
        apply(adapter);
        for (const [writer, size, versionOffset, vendorOffset, guidOffset] of [
            [writeAdapterIdentifier6, 1064, 1024, 1032, 1048],
            [writeAdapterIdentifier8, 1068, 1024, 1032, 1048],
            [writeAdapterIdentifier9, 1100, 1056, 1064, 1080],
        ] as const) {
            const mem = new Uint8Array(size + 64).fill(0xa5), base = 16;
            Mem.bind(() => mem);
            expect(writer(mem, base, 2)).toBe(true);
            const view = new DataView(mem.buffer);
            expect(view.getUint32(base + vendorOffset, true)).toBe(0x1002);
            expect(view.getUint32(base + vendorOffset + 4, true)).toBe(0x73bf);
            expect(view.getBigUint64(base + versionOffset, true)).toBe(0x001f00005de103ebn);
            expect(new TextDecoder().decode(mem.subarray(base, base + 512)).split('\0')[0]).toBe(adapter.driver);
            expect(new TextDecoder().decode(mem.subarray(base + 512, base + 1024)).split('\0')[0]).toBe(adapter.description);
            expect(view.getUint16(base + guidOffset, true)).toBe(adapter.vendorId);
            expect(mem[base - 1]).toBe(0xa5);
            expect(mem[base + size]).toBe(0xa5);
        }
    });

    test('reset drops adapter identity; applying a manifest owns a copy of its version', () => {
        const value = { ...adapter, driverVersion: [...adapter.driverVersion] } as GraphicsAdapterConfig;
        apply(value);
        value.driverVersion[0] = 1;
        expect(cfg.graphicsAdapter?.driverVersion[0]).toBe(31);
        cfg.reset();
        expect(cfg.graphicsAdapter).toBeNull();
    });

    test('rejects partial, out-of-range, oversized and malformed identities as a whole', () => {
        for (const value of [null, { vendorId: 0x1002 }, { ...adapter, deviceId: -1 },
            { ...adapter, deviceId: 0x10000 }, { ...adapter, description: 'x'.repeat(512) },
            { ...adapter, description: 'a\0b' }, { ...adapter, driver: 'C:/driver.dll' },
            { ...adapter, driverVersion: [31, 0, 1] }, { ...adapter, driverVersion: [31, 0, 1.5, 1] },
            { ...adapter, driverVersion: new Array(4) },
        ]) expect(normalizeGraphicsAdapter(value)).toBeNull();
        apply(adapter);
        apply({ vendorId: 0x10de } as GraphicsAdapterConfig);
        expect(cfg.graphicsAdapter).toBeNull();
    });
    test('writeAdapterIdentifier8 fills stable PCI ids', () => {
        const mem = new Uint8Array(D3DADAPTER_IDENTIFIER8_SIZE + 64);
        Mem.bind(() => mem);
        const base = 32;
        expect(writeAdapterIdentifier8(mem, base, 0)).toBe(true);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        expect(view.getUint32(base + 1032, true)).toBe(DEFAULT_VENDOR_ID);
        expect(view.getUint32(base + 1036, true)).toBe(DEFAULT_DEVICE_ID);

        const driver = new TextDecoder().decode(mem.subarray(base, base + 512));
        expect(driver.startsWith(DEFAULT_DRIVER_DLL)).toBe(true);
    });

    test('writeAdapterIdentifier9 matches D3D9 layout offsets', () => {
        const mem = new Uint8Array(D3DADAPTER_IDENTIFIER9_SIZE + 64);
        Mem.bind(() => mem);
        const base = 16;
        expect(writeAdapterIdentifier9(mem, base, 0)).toBe(true);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        expect(view.getUint32(base + D3DADAPTER_IDENTIFIER9_OFFSETS.VendorId, true)).toBe(DEFAULT_VENDOR_ID);
        expect(view.getUint32(base + D3DADAPTER_IDENTIFIER9_OFFSETS.DeviceId, true)).toBe(DEFAULT_DEVICE_ID);
    });
});
