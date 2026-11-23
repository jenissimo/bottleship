import { expect, test } from "bun:test";
import { getOrBuild } from "../../src/worker/wwt/pe-aot-cache";
import { peProfileEntries, PeProfileRecorder } from "../../src/worker/wwt/pe-profile";
import { installFakeOpfs } from "./fixtures/fake-opfs";

test("training stores relative executable entries and merges independent sessions for the same PE", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const file = Uint8Array.of(8, 12, 11);
    try {
        installFakeOpfs();
        const first = new PeProfileRecorder();
        await first.watch(file, 0x10000, [{start:0x10100, end:0x10400}]);
        first.miss(0x10140);
        first.miss(0x10140);
        first.miss(0x10500);
        await first.flush();
        const second = new PeProfileRecorder();
        await second.watch(file, 0x20000, [{start:0x20100, end:0x20400}]);
        second.miss(0x20280);
        second.reset();
        await second.flush();
        expect(await peProfileEntries(file, 0x30000, 0x1000)).toEqual([0x30140,0x30280]);
        expect(await peProfileEntries(file, 0x30000, 0x200)).toEqual([0x30140]);
        expect(await peProfileEntries(Uint8Array.of(0), 0x30000, 0x1000)).toEqual([]);
    } finally {
        if (previous) Object.defineProperty(globalThis, "navigator", previous);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});

test("PE translations are reused only for the same image and mode and recover from a damaged entry", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
        const root = installFakeOpfs();
        let builds = 0;
        const build = () => Uint8Array.of(++builds);
        const image = Uint8Array.of(1);
        expect(await getOrBuild(image, "compiler-1/paged", build)).toEqual(Uint8Array.of(1));
        expect(await getOrBuild(image, "compiler-1/paged", build)).toEqual(Uint8Array.of(1));
        const dir = await (await root.getDirectoryHandle("bottleship")).getDirectoryHandle("wwt-pe-aot-v1");
        const [name] = dir.children.keys();
        const file = await dir.getFileHandle(name);
        file.file.data[file.file.data.length - 1] ^= 1;
        expect(await getOrBuild(image, "compiler-1/paged", build)).toEqual(Uint8Array.of(2));
        expect(await getOrBuild(image, "compiler-1/flat", build)).toEqual(Uint8Array.of(3));
        expect(await getOrBuild(Uint8Array.of(2), "compiler-1/paged", build)).toEqual(Uint8Array.of(4));
        expect(await getOrBuild(image, "compiler-1/paged", build)).toEqual(Uint8Array.of(2));
        expect(builds).toBe(4);
    } finally {
        if (previous) Object.defineProperty(globalThis, "navigator", previous);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});
