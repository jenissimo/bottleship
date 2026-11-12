import { describe, expect, test } from "bun:test";
import { IDirectMusicSegment8 } from "../../src/worker/api/dmusic.api";

describe("IDirectMusicSegment8 vtable", () => {
    test("Compose sits between GetAudioPathConfig and Download", () => {
        const names = IDirectMusicSegment8.methods.map((m) => m.name);
        const at = names.indexOf("GetAudioPathConfig");
        expect(names.slice(at, at + 4)).toEqual(["GetAudioPathConfig", "Compose", "Download", "Unload"]);
    });
});
