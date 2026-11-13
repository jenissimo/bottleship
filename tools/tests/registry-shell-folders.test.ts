/**
 * HKCU\...\Explorer\Shell Folders is part of every Windows install. A Flash Player 7
 * projector reads its AppData value to find the SharedObject store; with the key missing
 * SharedObject.getLocal answered null and a title that keeps its key bindings there showed
 * "undefined" for every control.
 */
import { describe, expect, test } from "bun:test";
import { RegistryStore } from "../../src/worker/runtime/filesystem/registry";
import { CSIDL_APPDATA, CSIDL_LOCAL_APPDATA, CSIDL_PERSONAL, specialFolderPath } from "../../src/worker/runtime/filesystem/special-folders";

const SHELL_FOLDERS = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders";

describe("Explorer\\Shell Folders", () => {
    test("the key exists without a seed and names the folders shell32 answers", () => {
        const store = new RegistryStore();
        const key = store.open("HKEY_CURRENT_USER", SHELL_FOLDERS);
        expect(key).not.toBeNull();
        expect(store.getValue(key!, "AppData")?.data).toBe(specialFolderPath(CSIDL_APPDATA));
        expect(store.getValue(key!, "appdata")?.data).toBe("C:\\Windows\\Application Data");
        expect(store.getValue(key!, "Local AppData")?.data).toBe(specialFolderPath(CSIDL_LOCAL_APPDATA));
        expect(store.getValue(key!, "Personal")?.data).toBe(specialFolderPath(CSIDL_PERSONAL));
        expect(store.getValue(key!, "AppData")?.type).toBe("REG_SZ");
    });

    test("its parent keys open, as on Windows", () => {
        const store = new RegistryStore();
        expect(store.open("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer")).not.toBeNull();
    });

    test("a value the game or its bundle writes shadows the default", () => {
        const store = new RegistryStore();
        const { key } = store.createKey("HKCU", SHELL_FOLDERS);
        store.setValue(key, "AppData", { name: "AppData", type: "REG_SZ", data: "D:\\Elsewhere" });
        expect(store.getValue(store.open("HKCU", SHELL_FOLDERS)!, "AppData")?.data).toBe("D:\\Elsewhere");
        expect(store.getValue(key, "Personal")?.data).toBe("C:\\My Documents");
    });

    test("the default is not persisted as if the game had written it", () => {
        const store = new RegistryStore();
        store.open("HKCU", SHELL_FOLDERS);
        expect(JSON.stringify(store.serialize().keys).toLowerCase()).not.toContain("application data");
    });
});
