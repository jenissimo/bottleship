import { System } from "../../core/system";
import { LOBBY8_REGISTRY } from "./constants";
import type { Lobby8Program } from "./structures";
const names = ["ApplicationName", "CommandLine", "CurrentDirectory", "Description", "ExecutableFilename", "ExecutablePath", "LauncherFilename", "LauncherPath"];
export function lobby8Programs(): Lobby8Program[] {
    const registry = System.getInstance().registry, root = registry.open("hklm", LOBBY8_REGISTRY);
    const programs: Lobby8Program[] = [];
    for (const key of root ? registry.enumSubKeys(root) : []) {
        const guid = key.replace(/[{}]/g, "").toLowerCase();
        if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(guid)) continue;
        const path = registry.open("hklm", LOBBY8_REGISTRY + "\\" + key)!;
        programs.push({ guid, strings: names.map(name => { const data = registry.getValue(path, name)?.data; return typeof data === "string" ? data : null; }) });
    } return programs;
}
export function lobby8Registration(program: Lobby8Program | string): void {
    const registry = System.getInstance().registry, guid = typeof program === "string" ? program : program.guid;
    const path = LOBBY8_REGISTRY + "\\{" + guid.toUpperCase() + "}";
    if (typeof program === "string") { registry.deleteKey("hklm", path); return; }
    const key = registry.createKey("hklm", path).key;
    program.strings.forEach((value, index) => { if (value !== null) registry.setValue(key, names[index], { name: names[index], type: "REG_SZ", data: value }); });
}
