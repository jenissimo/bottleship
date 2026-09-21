/**
 * ExpandEnvironmentStrings' substitution rule.
 *
 * The case that matters is the UNDEFINED name: Windows copies `%NAME%` through
 * verbatim rather than substituting empty, and that is the only way a caller can
 * tell "never set" from "set to empty string". Answering empty for both looks
 * correct in every test that only checks defined names, and silently collapses a
 * path like `%GAMEDIR%\save` to `\save`.
 */
import { describe, expect, test } from "bun:test";
import { expandEnvironmentString } from "../../src/worker/modules/kernel32/environment";

const env: Record<string, string> = {
    WINDIR: "C:\WINDOWS",
    TEMP: "C:\TEMP",
    EMPTY: "",
};
const lookup = (n: string) => env[n];

describe("ExpandEnvironmentStrings substitution", () => {
    test("substitutes a defined name", () => {
        expect(expandEnvironmentString("%WINDIR%\system32", lookup)).toBe("C:\WINDOWS\system32");
    });

    test("an UNDEFINED name is copied through verbatim, percent signs included", () => {
        expect(expandEnvironmentString("%NOPE%\save", lookup)).toBe("%NOPE%\save");
    });

    test("a name set to the empty string substitutes to empty — not the same as undefined", () => {
        expect(expandEnvironmentString("[%EMPTY%]", lookup)).toBe("[]");
        expect(expandEnvironmentString("[%UNSET%]", lookup)).toBe("[%UNSET%]");
    });

    test("lookup is case-insensitive, as the environment block is", () => {
        expect(expandEnvironmentString("%windir%", lookup)).toBe("C:\WINDOWS");
        expect(expandEnvironmentString("%WinDir%", lookup)).toBe("C:\WINDOWS");
    });

    test("several names in one string", () => {
        expect(expandEnvironmentString("%TEMP%;%WINDIR%", lookup)).toBe("C:\TEMP;C:\WINDOWS");
    });

    test("an empty %% pair and an unpaired % are literal", () => {
        expect(expandEnvironmentString("100%% done", lookup)).toBe("100%% done");
        expect(expandEnvironmentString("50% off", lookup)).toBe("50% off");
    });

    test("text with no percent signs is returned unchanged", () => {
        expect(expandEnvironmentString("C:\games\bt", lookup)).toBe("C:\games\bt");
    });
});
