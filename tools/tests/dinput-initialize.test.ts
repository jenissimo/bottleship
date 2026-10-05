/**
 * IDirectInput[7|8]::Initialize version handshake — Wine dinput.c dinput7_Initialize and
 * dinput8_Initialize. The interface generation decides what is too new and what is beta.
 */

import { describe, expect, test } from "bun:test";
import {
    directInputInitialize, DI_OK, DIERR_INVALIDPARAM, DIERR_NOTINITIALIZED,
    DIERR_OLDDIRECTINPUTVERSION, DIERR_BETADIRECTINPUTVERSION,
} from "../../src/worker/modules/dinput/dinput-initialize";

const HINST = 0x400000;

describe("IDirectInput8::Initialize", () => {
    test("accepts exactly 0x0800", () => {
        expect(directInputInitialize(HINST, 0x0800, true)).toBe(DI_OK);
    });
    test("older is beta, newer is 'old DirectInput'", () => {
        expect(directInputInitialize(HINST, 0x0700, true)).toBe(DIERR_BETADIRECTINPUTVERSION);
        expect(directInputInitialize(HINST, 0x0900, true)).toBe(DIERR_OLDDIRECTINPUTVERSION);
    });
    test("hinst and version are both required", () => {
        expect(directInputInitialize(0, 0x0800, true)).toBe(DIERR_INVALIDPARAM);
        expect(directInputInitialize(HINST, 0, true)).toBe(DIERR_NOTINITIALIZED);
    });
});

describe("IDirectInput[7]::Initialize", () => {
    test("every released version up to 7 is accepted", () => {
        for (const v of [0x0300, 0x0500, 0x050a, 0x05b2, 0x0602, 0x061a, 0x0700]) {
            expect(directInputInitialize(HINST, v, false)).toBe(DI_OK);
        }
    });
    test("an unreleased number is beta; DirectInput 8 is too new for this interface", () => {
        expect(directInputInitialize(HINST, 0x0600, false)).toBe(DIERR_BETADIRECTINPUTVERSION);
        expect(directInputInitialize(HINST, 0x0800, false)).toBe(DIERR_OLDDIRECTINPUTVERSION);
    });
    test("error codes are the documented HRESULTs", () => {
        expect(DIERR_OLDDIRECTINPUTVERSION).toBe(0x8007047e);
        expect(DIERR_BETADIRECTINPUTVERSION).toBe(0x80070481);
        expect(DIERR_NOTINITIALIZED).toBe(0x80070015);
    });
});
