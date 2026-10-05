/**
 * dsound.dll's capture-8 and full-duplex entry points: ordinals and stdcall arity per the
 * shipped export table (Wine dsound.spec), and the IDirectSoundFullDuplex vtable shape.
 */

import { describe, expect, test } from "bun:test";
import { dsoundModule } from "../../src/worker/api/dsound.api";

describe("dsound descriptor", () => {
    const fn = (name: string) => dsoundModule.functions.find((f) => f.name === name)!;

    test("DirectSoundCaptureCreate8 is ordinal 12 with the Create signature", () => {
        expect(fn("DirectSoundCaptureCreate8").ordinal).toBe(12);
        expect(fn("DirectSoundCaptureCreate8").params.length).toBe(3);
    });

    test("DirectSoundFullDuplexCreate is ordinal 10 with ten arguments", () => {
        expect(fn("DirectSoundFullDuplexCreate").ordinal).toBe(10);
        expect(fn("DirectSoundFullDuplexCreate").params.length).toBe(10);
    });

    test("IDirectSoundFullDuplex is IUnknown + Initialize(this + 8)", () => {
        const iface = dsoundModule.interfaces!.find((i) => i.name === "IDirectSoundFullDuplex")!;
        expect(iface.methods.map((m) => m.name)).toEqual(["QueryInterface", "AddRef", "Release", "Initialize"]);
        expect(iface.methods[3]!.params.length).toBe(9);
    });
});
