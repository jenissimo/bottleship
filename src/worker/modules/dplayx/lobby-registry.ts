import { System } from "../../core/system";
export const DIRECTPLAY_APPLICATIONS = "Software\\Microsoft\\DirectPlay\\Applications";
export interface RegisteredDirectPlayApplication { name: string; guid: string; file: string; path: string; commandLine: string; currentDirectory: string; }
export function guidString(bytes: string): string {
    const fields = [bytes.slice(0, 8), bytes.slice(8, 12), bytes.slice(12, 16)].map(s => s.match(/../g)!.reverse().join(""));
    return "{" + fields[0] + "-" + fields[1] + "-" + fields[2] + "-" + bytes.slice(16, 20) + "-" + bytes.slice(20) + "}";
}
export function registeredDirectPlayApplications(system = System.getInstance()): RegisteredDirectPlayApplication[] {
    const registry = system.registry, root = registry.open("hklm", DIRECTPLAY_APPLICATIONS);
    const entries: RegisteredDirectPlayApplication[] = [];
    for (const name of root ? registry.enumSubKeys(root) : []) {
        const key = registry.open("hklm", DIRECTPLAY_APPLICATIONS + "\\" + name); if (!key) continue;
        const text = (value: string) => { const data = registry.getValue(key, value)?.data; return typeof data === "string" ? data : ""; };
        const guid = text("Guid");
        if (!/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(guid)) continue;
        entries.push({ name, guid: guid.toLowerCase(), file: text("File"), path: text("Path"), commandLine: text("CommandLine"), currentDirectory: text("CurrentDirectory") });
    }
    return entries;
}
