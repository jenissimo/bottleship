/**
 * A game's own VirtualRegistry shim (Steam's mafia.sdb) redirects HKLM\SOFTWARE\Illusion
 * Softworks\Mafia onto HKCU: the Czech Setup.exe writes the settings under HKLM, Game.exe reads
 * them from HKCU. Without the redirect the game finds nothing and relaunches Setup forever.
 */
import { describe, expect, test } from "bun:test";
import { RegistryStore } from "../../src/worker/runtime/filesystem/registry";

const MAFIA = { from: "HKLM\\SOFTWARE\\Illusion Softworks\\Mafia", to: "HKCU\\Software\\Illusion Softworks\\Mafia" };
const SETTINGS = { name: "LS3D_setup", type: "REG_BINARY" as const, data: "1400" };

describe("registry redirects", () => {
    test("a value Setup writes under HKLM is read by the game under HKCU", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        const { key } = store.createKey("HKLM", "Software\\Illusion Softworks\\Mafia");
        store.setValue(key, "LS3D_setup", SETTINGS);

        const opened = store.open("HKCU", "Software\\Illusion Softworks\\Mafia");
        expect(opened).toBe(key);
        expect(store.getValue(opened!, "LS3D_setup")?.data).toBe("1400");
    });

    test("subkeys follow, and a key opened above the redirect is joined before it applies", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        const parent = store.createKey("HKEY_LOCAL_MACHINE", "Software").key;
        const { key } = store.createKey(parent, "Illusion Softworks\\Mafia\\Profiles");
        expect(key).toBe("hkcu\\software\\illusion softworks\\mafia\\profiles");
    });

    test("seeds land where the redirect points", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        store.seed({ root: "HKLM", path: "SOFTWARE\\Illusion Softworks\\Mafia", values: [SETTINGS] });
        expect(store.open("HKCU", "Software\\Illusion Softworks\\Mafia")).not.toBeNull();
    });

    test("a sibling sharing the prefix is left alone", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        const { key } = store.createKey("HKLM", "Software\\Illusion Softworks\\Mafia II");
        expect(key).toBe("hklm\\software\\illusion softworks\\mafia ii");
    });

    test("reset drops the redirects with the rest of the game's hive", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        store.reset();
        expect(store.createKey("HKLM", "Software\\Illusion Softworks\\Mafia").key).toBe("hklm\\software\\illusion softworks\\mafia");
    });

    test("without rules nothing moves", () => {
        const store = new RegistryStore();
        const { key } = store.createKey("HKLM", "Software\\Illusion Softworks\\Mafia");
        expect(key).toBe("hklm\\software\\illusion softworks\\mafia");
    });
});
