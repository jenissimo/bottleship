import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSkip, parseArgs, planRoles, scriptMetadata } from "../lan-conformance/probe/case-metadata";

test("all address verbs and consumers participate in coordination and boot cleanup", () => {
    expect(scriptMetadata(`
      publishaddr socket udp
      publishlocal local 23913
      publiship host 127.0.0.1 23913
      target = waitaddr host t=30000
      gate ready t=1000
      signal got-ping
    `)).toEqual({ published: ["udp", "local", "host"], required: ["host"], gates: ["ready"], signals: ["got-ping"], skip: null });
});

test("single-script skip is honored only for emulated roles", () => {
    const text = "# emu-skip pending browser diagnosis\nwsastartup 0x202\n";
    expect(checkSkip([{ text, mode: "emu" }])).toBe("pending browser diagnosis");
    expect(checkSkip([{ text, mode: "native" }])).toBeNull();
    expect(checkSkip([{ text: "echo ok", mode: "emu" }, { text, mode: "native" }])).toBeNull();
});

test("the DP8 native-loopback host is skipped only when that host is emulated", () => {
    const cases = join(import.meta.dir, "../lan-conformance/cases/dp8");
    const host = readFileSync(join(cases, "interop.host.lp"), "utf8");
    const peer = readFileSync(join(cases, "interop.peer.lp"), "utf8");
    expect(checkSkip([{text:host,mode:"emu"}, {text:peer,mode:"emu"}])).toContain("Windows loopback");
    expect(checkSkip([{text:host,mode:"native"}, {text:peer,mode:"emu"}])).toBeNull();
    expect(checkSkip([{text:host,mode:"native"}, {text:peer,mode:"native"}])).toBeNull();
});

test("wire-host check and diagnostic runs use the same role plan", () => {
    const args = parseArgs(["dp8/interop", "--wire-host", "--as=peer=native"]);
    expect(args.rest).toEqual(["dp8/interop"]);
    expect(planRoles(["host", "peer"], "check", args.roleModes, args.wireHost)).toEqual([{ role: "peer", mode: "native" }]);
    expect(planRoles(["host", "peer"], "run", args.roleModes, args.wireHost)).toEqual([{ role: "peer", mode: "native" }]);
    expect(() => planRoles(["host", "peer"], "record", undefined, true)).toThrow("native roles");
    expect(() => planRoles(["host", "peer"], "check", { other: "native" })).toThrow("unknown role");
    expect(() => parseArgs(["--as=peer=oops"])).toThrow();
});
