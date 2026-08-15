/**
 * argv[0] quoting — the command line we hand the guest, and the one we read back
 * from CreateProcess, must agree.
 *
 * Win32 has no argv array: a child gets ONE string, and argv[0] ends at the first
 * space unless it is quoted. An image path with a space that we publish unquoted is
 * therefore mis-split by every guest that parses its own command line — and a
 * launcher that strips its argv[0] to build a child's command line keeps the tail
 * as an argument, permanently. Warcraft III Demo relaunched itself forever on it,
 * accumulating one more "III Demo.exe" per restart.
 *
 * The invariant is a ROUND TRIP: what we build, our own CreateProcess tokenizer
 * must split back into exactly the name and the arguments that went in.
 */

import { describe, expect, test } from "bun:test";
import { buildGuestCommandLine } from "../../src/worker/modules/kernel32/command/command";
import { firstCommandLineToken, stripFirstCommandLineToken } from "../../src/worker/modules/kernel32/process/process";

describe("guest command line: argv[0] quoting", () => {
    test("a name with spaces is quoted", () => {
        expect(buildGuestCommandLine("Warcraft III Demo.exe", "")).toBe('"Warcraft III Demo.exe"');
        expect(buildGuestCommandLine("Warcraft III Demo.exe", "-opengl")).toBe('"Warcraft III Demo.exe" -opengl');
    });

    test("a name without spaces is left bare", () => {
        expect(buildGuestCommandLine("war3demo.exe", "")).toBe("war3demo.exe");
        expect(buildGuestCommandLine("war3demo.exe", "-opengl")).toBe("war3demo.exe -opengl");
    });
});

describe("guest command line: round trip through the CreateProcess tokenizer", () => {
    const CASES: Array<[name: string, args: string]> = [
        ["war3demo.exe", ""],
        ["war3demo.exe", "-opengl -window"],
        ["Warcraft III Demo.exe", ""],
        ["Warcraft III Demo.exe", "-opengl"],
        ["C:\\Program Files\\Game\\game.exe", "-nocd"],
    ];

    for (const [name, args] of CASES) {
        test(`"${name}" + "${args}"`, () => {
            const line = buildGuestCommandLine(name, args);
            expect(firstCommandLineToken(line)).toBe(name);
            expect(stripFirstCommandLineToken(line)).toBe(args);
        });
    }

    test("the accumulation the bug produced does not survive one round trip", () => {
        // Unquoted, argv[0] stops at "Warcraft" and "III Demo.exe" becomes an argument
        // the launcher then passes on — the growth loop's first step.
        expect(stripFirstCommandLineToken("Warcraft III Demo.exe")).toBe("III Demo.exe");
        expect(stripFirstCommandLineToken(buildGuestCommandLine("Warcraft III Demo.exe", ""))).toBe("");
    });
});
