import { describe, expect, test } from "bun:test";
import { makeWsaStartup, negotiateWsaVersion, writeWsaData } from "../../src/worker/modules/wsa-stub-shared";

describe("wsa-stub-shared", () => {
    test("negotiateWsaVersion returns 1.1 for HL request 0x0101", () => {
        expect(negotiateWsaVersion(0x0101)).toEqual({ wVersion: 0x0101, wHighVersion: 0x0202 });
    });

    test("Winsock 2.0 callers receive 2.0 rather than an unrequested 2.2", () => {
        const mem = new Uint8Array(0x400);
        const startup = makeWsaStartup(() => {}, 10014, -1);
        expect(startup({} as any, mem, [0x0002, 0x100])).toBe(0);
        expect(new DataView(mem.buffer).getUint16(0x100, true)).toBe(0x0002);
        expect(new DataView(mem.buffer).getUint16(0x102, true)).toBe(0x0202);
        expect(negotiateWsaVersion(0x0102).wVersion).toBe(0x0102);
        expect(negotiateWsaVersion(0x0902).wVersion).toBe(0x0202);
        expect(negotiateWsaVersion(0x0003).wVersion).toBe(0x0202);
    });

    test("writeWsaData sets wVersion bytes HL checks after WSAStartup", () => {
        const mem = new Uint8Array(0x200);
        const ok = writeWsaData(0x40, 0x0101, mem);
        expect(ok).toBe(true);
        expect(mem[0x40]).toBe(0x01);
        expect(mem[0x41]).toBe(0x01);
        expect(mem[0x42]).toBe(0x02);
        expect(mem[0x43]).toBe(0x02);
    });

    test("makeWsaStartup uses stdcall arg order (version first, buffer second)", () => {
        const mem = new Uint8Array(0x400);
        const bufOff = 0x100;
        let lastError = -1;
        const startup = makeWsaStartup((code) => { lastError = code; }, 10014, -1);
        const ret = startup({} as any, mem, [0x0101, bufOff]);
        expect(ret).toBe(0);
        expect(lastError).toBe(0);
        expect(mem[bufOff]).toBe(0x01);
        expect(mem[bufOff + 1]).toBe(0x01);
    });
});
