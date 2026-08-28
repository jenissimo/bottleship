import { describe, expect, test } from "bun:test";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

describe("D3D9 resource loss pool semantics", () => {
    test("DEFAULT texture contents are lost while MANAGED shadow data is restorable", () => {
        const store = new TextureStore(2);
        const defaultIndex = store.create(0x1001, 2, 2, 1, 21, 0, 0);
        const managedIndex = store.create(0x1002, 2, 2, 1, 21, 0, 1);
        store.getData(defaultIndex)!.fill(0xab);
        store.getData(managedIndex)!.fill(0xcd);
        store.setDirty(defaultIndex, false);
        store.setDirty(managedIndex, false);

        const result = store.dropGpuResources();

        expect(result.contentLost).toBe(1);
        expect(result.contentLostHandles).toEqual([0x1001]);
        expect(Array.from(store.getData(defaultIndex)!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0]);
        expect(Array.from(store.getData(managedIndex)!)).toEqual(new Array(16).fill(0xcd));
        expect(store.isDirty(defaultIndex)).toBe(false);
        expect(store.isDirty(managedIndex)).toBe(true);
    });
});
