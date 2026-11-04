// The iOS WebKit 27 JIT gate: an affected device must boot with the JIT off, everything
// else must keep shipping behaviour, and ?jit= must win in both directions.

import { describe, expect, test } from "bun:test";
import { applyHostJitMode, resolveHostJitPolicy } from "../../src/utils/host-jit-policy";

const IPHONE_27 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
const IPHONE_26 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
const IPHONE_17 = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_FROZEN = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_18_5 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1";
const MAC_SAFARI_27 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const policy = (userAgent: string, maxTouchPoints = 5, search = "") =>
    resolveHostJitPolicy({ userAgent, maxTouchPoints, search });

describe("host JIT policy", () => {
    test("iPhone Safari 27 boots with the JIT but without tail calls", () => {
        expect(policy(IPHONE_27)).toEqual({ mode: "notail", reason: "ios-webkit-27" });
    });

    test("iPadOS 27 reporting a Mac UA is caught by its touch points", () => {
        expect(policy(MAC_SAFARI_27, 5).mode).toBe("notail");
    });

    test("macOS Safari 27 keeps the JIT", () => {
        expect(policy(MAC_SAFARI_27, 0)).toEqual({ mode: "on", reason: "default" });
    });

    test("iOS 26 and earlier keep the JIT", () => {
        expect(policy(IPHONE_26).mode).toBe("on");
        expect(policy(IPHONE_17).mode).toBe("on");
        expect(policy(IPHONE_CHROME_18_5).mode).toBe("on");
    });

    test("a frozen OS token with no Version token is treated as affected", () => {
        expect(policy(IPHONE_CHROME_FROZEN).mode).toBe("notail");
    });

    test("desktop Chromium is untouched, touchscreen or not", () => {
        expect(policy(WINDOWS_CHROME, 10).mode).toBe("on");
        expect(policy(MAC_CHROME, 0).mode).toBe("on");
    });

    test("?jit= overrides the gate in both directions", () => {
        expect(policy(IPHONE_27, 5, "?game=dev&jit=1")).toEqual({ mode: "on", reason: "query" });
        expect(policy(IPHONE_27, 5, "?jit=notail").mode).toBe("notail");
        expect(policy(WINDOWS_CHROME, 0, "?jit=0")).toEqual({ mode: "off", reason: "query" });
        expect(policy(IPHONE_27, 5, "?jit=bogus").mode).toBe("notail");
        expect(policy(IPHONE_27, 5, "?jit=0")).toEqual({ mode: "off", reason: "query" });
    });
});

describe("applyHostJitMode", () => {
    const recorder = () => {
        const calls: Array<[number, number]> = [];
        return { calls, ex: { set_jit_config: (i: number, v: number) => { calls.push([i, v]); return 0; } } };
    };

    test("on writes nothing, so the shipping configuration stands", () => {
        const r = recorder();
        expect(applyHostJitMode(r.ex, "on")).toEqual([]);
        expect(r.calls).toEqual([]);
    });

    test("off disables compilation", () => {
        const r = recorder();
        applyHostJitMode(r.ex, "off");
        expect(r.calls).toEqual([[0, 1]]);
    });

    test("notail turns off both tail-call emitters", () => {
        const r = recorder();
        applyHostJitMode(r.ex, "notail");
        expect(r.calls).toEqual([[4, 0], [12, 0]]);
    });

    test("a rejected slot is an error, not a silent JIT-on", () => {
        expect(() => applyHostJitMode({ set_jit_config: () => 0xFFFFFFFF }, "off")).toThrow();
    });
});
