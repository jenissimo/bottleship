/**
 * A predefined hive is one key space however it is spelled. advapi32 names it by the short
 * form (HKCR) while COM activation reads the long one (HKEY_CLASSES_ROOT); when those were
 * two stores, a title that self-registers its InprocServer32 before CoCreateInstance wrote a
 * key our activation could never read, and the class came back not registered.
 */
import { describe, expect, test } from "bun:test";
import { RegistryStore } from "../../src/worker/runtime/filesystem/registry";

const CLSID_PATH = "CLSID\\{92FA2C24-253C-11d2-90FB-006008A1F441}\\InprocServer32";

describe("registry root aliases", () => {
    test("a value written under HKCR is read under HKEY_CLASSES_ROOT", () => {
        const store = new RegistryStore();
        const { key } = store.createKey("HKCR", CLSID_PATH);
        store.setValue(key, "", { name: "", type: "REG_SZ", data: "a3dapi.dll" });

        const opened = store.open("HKEY_CLASSES_ROOT", CLSID_PATH);
        expect(opened).not.toBeNull();
        expect(store.getValue(opened!, "")?.data).toBe("a3dapi.dll");
    });

    test("every long hive name folds onto its short form", () => {
        const pairs: Array<[string, string]> = [
            ["HKEY_LOCAL_MACHINE", "HKLM"], ["HKEY_CURRENT_USER", "HKCU"], ["HKEY_USERS", "HKU"],
            ["HKEY_CURRENT_CONFIG", "HKCC"], ["HKEY_DYN_DATA", "HKDD"], ["HKEY_PERFORMANCE_DATA", "HKPD"],
        ];
        for (const [long, short] of pairs) {
            const store = new RegistryStore();
            const { key } = store.createKey(long, "Software\\Probe");
            expect(store.open(short, "Software\\Probe")).toBe(key);
        }
    });

    test("a persisted key saved under a long root is reachable after restore", () => {
        const store = new RegistryStore();
        store.restore({
            version: 2, gameId: "t", lastModified: 0,
            keys: { ["hkey_classes_root\\" + CLSID_PATH.toLowerCase()]: { "": { name: "", type: "REG_SZ", data: "x.dll" } } },
        } as any);
        const opened = store.open("HKCR", CLSID_PATH);
        expect(opened).not.toBeNull();
        expect(store.getValue(opened!, "")?.data).toBe("x.dll");
    });
});
