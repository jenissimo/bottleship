/**
 * normalizeInnoDestination — which installer destinations become bundle paths.
 *
 * The brace cases are the ones that cost us files: a doubled brace is a LITERAL brace in a
 * filename, a single one is a constant. Conflating them drops real content with no error.
 */

import { describe, expect, it } from "bun:test";
import { normalizeInnoDestination } from "../../packages/formats/src/inno/paths";

const bare = { allowBareRelative: true };

describe("normalizeInnoDestination", () => {
    it("strips {app} and switches to forward slashes", () => {
        expect(normalizeInnoDestination("{app}\\Data\\Anims\\PlanetD.znm")).toBe("Data/Anims/PlanetD.znm");
        expect(normalizeInnoDestination("{app}/RESOURCE\\TEXTS\\Money.txt")).toBe("RESOURCE/TEXTS/Money.txt");
    });

    it("keeps a bare relative path only when the caller allows it", () => {
        expect(normalizeInnoDestination("Binds\\CFGB0000.BND", bare)).toBe("Binds/CFGB0000.BND");
        expect(normalizeInnoDestination("Binds\\CFGB0000.BND")).toBeNull();
    });

    it("keeps a doubled brace verbatim — it is part of the name, not an escape", () => {
        // Worms Armageddon's stock schemes. The doubled braces ARE the filename: GOG's
        // installed-file manifest (goggame-*.hashdb) lists
        // "User\Schemes\{{01}} Beginner.wsc", and WA.exe opens
        // "User\Schemes\{{%02d}} %s.wsc". Collapsing them to {01} keeps the files under a
        // name the game never asks for, which is indistinguishable from losing them.
        expect(normalizeInnoDestination("User\\Schemes\\{{01}} Beginner.wsc", bare))
            .toBe("User/Schemes/{{01}} Beginner.wsc");
        expect(normalizeInnoDestination("{app}\\User\\Schemes\\{{12}} Blast Zone.wsc"))
            .toBe("User/Schemes/{{12}} Blast Zone.wsc");
        // A doubled brace is literal in the leading component too — and is NOT the {app}
        // constant, so it does not resolve the destination root away.
        expect(normalizeInnoDestination("{{app}}\\x.txt", bare)).toBe("{{app}}/x.txt");
    });

    it("installs GOG's __support\\app tree into the app directory", () => {
        // Far Cry's key-binding defaults; the installer copies this tree over {app}, and
        // most of its entries carry no {app} constant at all — so the bare-relative gate
        // must not decide them.
        expect(normalizeInnoDestination("__support/app\\Profiles\\defaults\\english\\game.cfg"))
            .toBe("Profiles/defaults/english/game.cfg");
        expect(normalizeInnoDestination("{app}/__support/app\\Profiles\\server\\mapcycle.txt"))
            .toBe("Profiles/server/mapcycle.txt");
        // The rest of __support really is installer scaffolding.
        expect(normalizeInnoDestination("__support\\gog_installer.dll", bare))
            .toBe("__support/gog_installer.dll");
    });

    it("rejects installer-runtime and unresolved constants", () => {
        expect(normalizeInnoDestination("{tmp}\\background.jpg", bare)).toBeNull();
        expect(normalizeInnoDestination("{commonappdata}\\GOG.com\\uninstall.dll", bare)).toBeNull();
        expect(normalizeInnoDestination("{app}\\{sys}\\x.dll")).toBeNull();
        expect(normalizeInnoDestination("{unterminated", bare)).toBeNull();
    });

    it("refuses paths that escape the bundle root", () => {
        expect(normalizeInnoDestination("{app}\\..\\..\\windows\\system32\\x.dll")).toBeNull();
        expect(normalizeInnoDestination("C:\\absolute\\x.dll", bare)).toBeNull();
        expect(normalizeInnoDestination("\\leading\\x.dll", bare)).toBeNull();
        expect(normalizeInnoDestination("", bare)).toBeNull();
    });
});
