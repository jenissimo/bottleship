/**
 * A game's own VirtualRegistry shim (Steam's mafia.sdb) redirects HKLM\SOFTWARE\Illusion
 * Softworks\Mafia onto HKCU: the Czech Setup.exe writes the settings under HKLM, Game.exe reads
 * them from HKCU. Without the redirect the game finds nothing and relaunches Setup forever.
 */
import { describe, expect, test } from "bun:test";
import { RegistryStore, type RegistryMutation } from "../../src/worker/runtime/filesystem/registry";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import type { WgbManifest } from "../../src/worker/runtime/filesystem/wgb-loader";

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

    test("seeds are the hive's real contents: they land where they name", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        store.seed({ root: "HKCU", path: "Software\\Illusion Softworks\\Mafia", values: [SETTINGS] });
        store.seed({ root: "HKLM", path: "SOFTWARE\\Illusion Softworks\\Mafia", values: [{ ...SETTINGS, data: "raw" }] });
        expect(Object.keys(store.serialize().keys)).toEqual([
            "hkcu\\software\\illusion softworks\\mafia",
            "hklm\\software\\illusion softworks\\mafia",
        ]);
        // The redirected process sees the HKCU copy under either name.
        expect(store.getValue(store.open("HKLM", "Software\\Illusion Softworks\\Mafia")!, "LS3D_setup")?.data).toBe("1400");
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

describe("a redirect is applied exactly once", () => {
    test("handle -> createKey, then serialize/restore, does not grow the path", () => {
        const store = new RegistryStore();
        store.setRedirects([MAFIA]);
        const handle = store.createKey("HKLM", "Software\\Illusion Softworks\\Mafia").key;
        const sub = store.createKey(handle, "Profiles").key;
        expect(sub).toBe("hkcu\\software\\illusion softworks\\mafia\\profiles");
        expect(store.open(handle, "Profiles")).toBe(sub);
        store.setValue(sub, "Name", { name: "Name", type: "REG_SZ", data: "Tommy" });

        const restored = new RegistryStore();
        restored.setRedirects([MAFIA]);
        restored.restore(store.serialize());
        restored.restore(restored.serialize());
        expect(Object.keys(restored.serialize().keys).sort()).toEqual(Object.keys(store.serialize().keys).sort());
        expect(restored.getValue(sub, "Name")?.data).toBe("Tommy");
    });

    test("a target inside its own source is rejected, so nothing grows", () => {
        const store = new RegistryStore();
        const accepted = store.setRedirects([{ from: "HKLM\\Software\\X", to: "HKLM\\Software\\X\\Y" }]);
        const handle = store.createKey("HKLM", "Software\\X").key;
        expect(store.createKey(handle, "Sub").key).toBe("hklm\\software\\x\\sub");
        expect(accepted).toEqual([]);
        const restored = new RegistryStore();
        restored.setRedirects([{ from: "HKLM\\Software\\X", to: "HKLM\\Software\\X\\Y" }]);
        restored.restore(store.serialize());
        expect(Object.keys(restored.serialize().keys).sort()).toEqual(["hklm\\software\\x", "hklm\\software\\x\\sub"]);
    });

    test("A->B with B->A is rejected and relative paths keep working", () => {
        const store = new RegistryStore();
        const accepted = store.setRedirects([
            { from: "HKLM\\Software\\A", to: "HKLM\\Software\\B" },
            { from: "HKLM\\Software\\B", to: "HKLM\\Software\\A" },
        ]);
        const a = store.createKey("HKLM", "Software\\A").key;
        expect(store.createKey(a, "Sub").key).toBe("hklm\\software\\a\\sub");
        expect(accepted).toEqual([]);
    });

    test("rules on a whole root are rejected; no doubled separators", () => {
        const store = new RegistryStore();
        const accepted = store.setRedirects([
            { from: "HKLM", to: "HKCU\\Software\\X" },
            { from: "HKLM\\Software\\X", to: "HKCU" },
        ]);
        expect(store.createKey("HKLM", "Software\\X\\Sub").key).toBe("hklm\\software\\x\\sub");
        expect(store.createKey("HKLM", "Software\\Y").key).toBe("hklm\\software\\y");
        expect(accepted).toEqual([]);
    });

    test("an empty rule set leaves every name as given", () => {
        const store = new RegistryStore();
        store.setRedirects([]);
        expect(store.createKey("HKEY_CURRENT_USER", "\\Software\\Game\\").key).toBe("hkcu\\software\\game");
    });
});

describe("redirects belong to a process", () => {
    const RULES = [
        { exe: "Game.exe", ...MAFIA },
        { exe: "Setup.exe", from: "HKLM\\Software\\Vendor\\Setup", to: "HKCU\\Software\\Vendor\\Setup" },
    ];

    test("the process whose image an entry names is redirected; another is not", () => {
        const game = new RegistryStore();
        const tool = new RegistryStore();
        expect(game.setRedirectsForImage(RULES, "C:\\Mafia\\GAME.EXE")).toEqual([MAFIA]);
        expect(tool.setRedirectsForImage(RULES, "C:\\Mafia\\Tool.exe")).toEqual([]);
        expect(game.createKey("HKLM", "Software\\Illusion Softworks\\Mafia").key).toBe("hkcu\\software\\illusion softworks\\mafia");
        expect(tool.createKey("HKLM", "Software\\Illusion Softworks\\Mafia").key).toBe("hklm\\software\\illusion softworks\\mafia");
    });

    test("a child inherits the bundle's rules and selects the ones for its own image", () => {
        const config = EmulatorConfig.getInstance();
        try {
            config.reset();
            config.applyFromManifest({ emulator: { registryRedirects: RULES } } as unknown as WgbManifest);
            const snapshot = config.snapshotForChild();
            config.reset();
            config.restoreForChild(snapshot);

            const child = new RegistryStore();
            expect(child.setRedirectsForImage(config.registryRedirects, "C:\\Mafia\\Setup.exe"))
                .toEqual([{ from: RULES[1]!.from, to: RULES[1]!.to }]);
            expect(child.createKey("HKLM", "Software\\Illusion Softworks\\Mafia").key).toBe("hklm\\software\\illusion softworks\\mafia");
            expect(child.createKey("HKLM", "Software\\Vendor\\Setup").key).toBe("hkcu\\software\\vendor\\setup");
        } finally {
            config.reset();
        }
    });

    test("a write replayed in another process lands on the key its writer resolved", () => {
        const child = new RegistryStore();
        const owner = new RegistryStore();
        child.setRedirectsForImage(RULES, "C:\\Mafia\\Game.exe");
        owner.setRedirectsForImage(RULES, "C:\\Mafia\\Launcher.exe");
        const sent: RegistryMutation[] = [];
        child.setMutationSink((m) => sent.push(m));

        const { key } = child.createKey("HKLM", "Software\\Illusion Softworks\\Mafia\\Profiles");
        child.setValue(key, "Name", { name: "Name", type: "REG_SZ", data: "Tommy" });
        child.deleteKey("HKLM\\Software\\Illusion Softworks\\Mafia".toLowerCase(), "Profiles");
        for (const m of sent.slice(0, 2)) owner.applyMutation(m);
        expect(Object.keys(owner.serialize().keys)).toEqual(["hkcu\\software\\illusion softworks\\mafia\\profiles"]);
        owner.applyMutation(sent[2]!);
        expect(Object.keys(owner.serialize().keys)).toEqual([]);
    });
});
