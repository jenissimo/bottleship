import { expect, spyOn, test } from "bun:test";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { BinkW32 } from "../../src/worker/modules/binkw32";

test("a skipped Bink clip completes for callers using either HBINK or BinkGetSummary frame counts", async () => {
    const mem = new Uint8Array(4096);
    const view = new DataView(mem.buffer);
    const module = new BinkW32();
    module.initialize({ memory: { alloc: () => 512 } } as never);
    const header = new Uint8Array(44);
    header.set([0x42, 0x49, 0x4b, 0x69]);
    const hv = new DataView(header.buffer);
    for (const [offset, value] of [[8, 612], [20, 640], [24, 480], [28, 30], [32, 1]]) {
        hv.setUint32(offset, value, true);
    }
    mem.set(new TextEncoder().encode("intro.bik\0"), 32);
    let clip: Uint8Array | null = header;
    Object.assign(module, {
        ensureLayout: async () => {},
        getMemory: () => mem,
        readVfsHeader: async () => clip,
    });
    const config = EmulatorConfig.getInstance();
    const oldSkip = config.skipVideo;
    const memWrite = spyOn(Mem, "writeUint32").mockReturnValue(false);
    config.skipVideo = true;
    try {
        const handle = await module.exports["_BinkOpen@8"]({} as never, mem, [32, 0]);
        expect(handle).toBe(512);
        await module.exports["_BinkGetSummary@8"]({} as never, mem, [512, 1024]);
        const u32 = (offset: number) => view.getUint32(offset, true);
        expect([u32(512), u32(516), u32(520), u32(524)]).toEqual([640, 480, 1, 1]);
        expect([u32(1024), u32(1028), u32(1024 + 0x20)]).toEqual([640, 480, 1]);
        expect(module.exports["_BinkWait@4"]({} as never, mem, [512])).toBe(0);
        await module.exports["_BinkGoto@12"]({} as never, mem, [512, 1, 0]);
        await module.exports["_BinkNextFrame@4"]({} as never, mem, [512]);
        expect(u32(524)).toBe(1);
        clip = null;
        expect(await module.exports["_BinkOpen@8"]({} as never, mem, [32, 0])).toBe(0);
    } finally {
        config.skipVideo = oldSkip;
        memWrite.mockRestore();
    }
});
