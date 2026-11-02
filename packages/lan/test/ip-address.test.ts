/// <reference types="bun" />
import { expect, test } from "bun:test";
import { parseIpv6, formatIpv6 } from "../src/ip-address";

test("IPv6 parsing and canonical formatting follow compression and embedded IPv4 rules", () => {
    for (const [input, canonical] of [
        ["0:0:0:0:0:0:0:0", "::"], ["0:0:0:0:0:0:0:1", "::1"],
        ["2001:0DB8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
        ["::ffff:192.0.2.128", "::ffff:c000:280"],
        ["1:2:3:4:5:6:192.0.2.128", "1:2:3:4:5:6:c000:280"],
        ["fe80::1%12", "fe80::1"],
    ]) expect(formatIpv6(parseIpv6(input)!)).toBe(canonical);
    for (const input of ["", ":", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3",
        "1:2:3:4:5:6:7:8::", "192.0.2.1::", "1:192.0.2.1::", "::ffff:192.0.2.256",
        "::ffff:192.0.2.1:2", "::g", "::1%", "::1%1%2"]) expect(parseIpv6(input)).toBeNull();
    const bytes = parseIpv6("2001:db8::42")!;
    const padded = new Uint8Array(20); padded.set(bytes, 2);
    expect(formatIpv6(padded.subarray(2, 18))).toBe("2001:db8::42");
    expect(() => formatIpv6(new Uint8Array(15))).toThrow(RangeError);
});
