import { RegistryPersistence, RegistryAccessLogEntry, PersistedRegistryState } from "./registry-persistence";
import { Logger, LogCategory } from "../../core/logger";
import { EmulatorConfig } from "../../core/emulator-config-manager";

export type RegistryValueType = "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";

const VALID_REG_TYPES = new Set<string>(["REG_SZ", "REG_DWORD", "REG_BINARY", "REG_MULTI_SZ"]);
const IMPLICIT_EMPTY_KEYS = new Set<string>([
    "hkcu\\software",
    "hklm\\software",
]);

function validateRegType(type: string): RegistryValueType {
    if (!VALID_REG_TYPES.has(type)) {
        throw new Error(`Unknown registry type "${type}". Valid types: ${[...VALID_REG_TYPES].join(", ")}`);
    }
    return type as RegistryValueType;
}

export interface RegistryValue {
    name: string;
    type: RegistryValueType;
    data: string | number;
}

export interface RegistrySeed {
    root: string;
    path: string;
    values: RegistryValue[];
}

/** VER_PLATFORM_WIN32_WINDOWS — the Win9x branch of EmulatorConfig.osVersion. */
const PLATFORM_WIN32_WINDOWS = 1;

function sz(name: string, data: string): RegistryValue {
    return { name, type: "REG_SZ", data };
}

/**
 * The keys a Windows install ALWAYS has, which no bundle should have to ship.
 *
 * A launcher that reads HKLM\SOFTWARE\Microsoft\DirectX\Version and finds nothing does
 * not conclude "unknown" — it concludes DirectX is absent and refuses to start, or
 * offers to install it. Writing that into every bundle's registry.json would be a
 * per-game crutch for a fact about the SYSTEM, so the system provides it.
 *
 * Built on first READ, never at seed time: the manifest's osVersion is applied after
 * boot seeding, and these values must describe the OS we actually report to
 * GetVersionEx. They live outside the key store, so a bundle seed or a value the game
 * writes shadows them, and nothing here is ever persisted as if the game had written it.
 */
function buildSystemDefaults(osVersion: {
    major: number; minor: number; build: number; platformId: number;
}): RegistrySeed[] {
    const { major, minor, build, platformId } = osVersion;
    const isWin9x = platformId === PLATFORM_WIN32_WINDOWS;
    const productName = isWin9x
        ? (minor >= 90 ? "Microsoft Windows Me" : minor >= 10 ? "Microsoft Windows 98" : "Microsoft Windows 95")
        : (major === 5 && minor === 0 ? "Microsoft Windows 2000" : "Microsoft Windows XP");

    // The shared HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion values every installer
    // reads, plus the OS identity in the place THIS platform keeps it: Win9x under
    // Windows\CurrentVersion, NT under Windows NT\CurrentVersion.
    const commonCurrentVersion: RegistryValue[] = [
        sz("ProgramFilesDir", "C:\\Program Files"),
        sz("CommonFilesDir", "C:\\Program Files\\Common Files"),
        sz("SystemRoot", "C:\\WINDOWS"),
        sz("DevicePath", "C:\\WINDOWS\\INF"),
    ];
    const osIdentity: RegistryValue[] = isWin9x
        ? [
            sz("Version", productName.replace("Microsoft ", "")),
            sz("VersionNumber", `${major}.${minor}.${build}`),
            sz("SubVersionNumber", ""),
            sz("ProductName", productName),
        ]
        : [
            sz("CurrentVersion", `${major}.${minor}`),
            sz("CurrentBuildNumber", String(build)),
            sz("CurrentBuild", String(build)),
            sz("ProductName", productName),
            sz("CSDVersion", ""),
            sz("SystemRoot", "C:\\WINDOWS"),
        ];

    const seeds: RegistrySeed[] = [
        {
            root: "HKLM", path: "Software\\Microsoft\\Windows\\CurrentVersion",
            values: isWin9x ? [...commonCurrentVersion, ...osIdentity] : commonCurrentVersion,
        },
        // DirectX 9.0c — the highest version we implement (ddraw/d3d7/d3d8/d3d9). The
        // string form is what the DX runtime writes and what launchers compare against.
        {
            root: "HKLM", path: "Software\\Microsoft\\DirectX",
            values: [sz("Version", "4.09.00.0904")],
        },
    ];
    if (!isWin9x) {
        seeds.push({
            root: "HKLM", path: "Software\\Microsoft\\Windows NT\\CurrentVersion",
            values: osIdentity,
        });
    }
    return seeds;
}

export class RegistryStore {
    private keys: Map<string, Map<string, RegistryValue>> = new Map();
    /** Lazily built system baseline (see buildSystemDefaults); null until first read. */
    private systemDefaults: Map<string, Map<string, RegistryValue>> | null = null;
    private gameId: string = "";
    private accessLogBuffer: RegistryAccessLogEntry[] = [];
    private onChangeCallback: (() => void) | null = null;
    private readonly MAX_LOG_BUFFER_SIZE = 1000;

    reset(): void {
        this.keys.clear();
        this.systemDefaults = null;
        this.accessLogBuffer = [];
        this.gameId = "";
        this.onChangeCallback = null;
    }

    /** The system baseline, built on first use so it reflects the manifest's osVersion
     *  (applied after boot seeding) rather than the pre-manifest default. */
    private defaults(): Map<string, Map<string, RegistryValue>> {
        if (this.systemDefaults) return this.systemDefaults;
        const map = new Map<string, Map<string, RegistryValue>>();
        for (const seed of buildSystemDefaults(EmulatorConfig.getInstance().osVersion)) {
            const values = new Map<string, RegistryValue>();
            for (const value of seed.values) values.set(value.name.toLowerCase(), value);
            map.set(this.normalizeKey(seed.root, seed.path), values);
        }
        this.systemDefaults = map;
        return map;
    }

    /** Stored values shadow the baseline, name by name. */
    private mergedValues(keyHandle: string): Map<string, RegistryValue> | null {
        const stored = this.keys.get(keyHandle);
        const base = this.defaults().get(keyHandle);
        if (!base) return stored ?? null;
        if (!stored) return base;
        const merged = new Map(base);
        for (const [name, value] of stored) merged.set(name, value);
        return merged;
    }

    seed(seed: RegistrySeed | RegistrySeed[] | any): void {
        // Support array of RegistrySeed objects
        if (Array.isArray(seed)) {
            Logger.log(LogCategory.SYSTEM, `Registry seed: processing array of ${seed.length} entries`);
            for (const entry of seed) {
                this.seed(entry);
            }
            return;
        }
        // Support single RegistrySeed object
        if (seed.root && seed.path && Array.isArray(seed.values)) {
            const key = this.normalizeKey(seed.root, seed.path);
            Logger.log(LogCategory.SYSTEM, `Registry seed: ${key} (${seed.values.length} values)`);
            let existing = this.keys.get(key);
            if (!existing) {
                existing = new Map();
                this.keys.set(key, existing);
            }
            for (const value of seed.values) {
                existing.set(value.name.toLowerCase(), {
                    ...value,
                    type: validateRegType(value.type),
                });
            }
        } else {
            // Hierarchical format: { "HKEY_LOCAL_MACHINE": { "Software": { ... } } }
            this.seedHierarchical(seed);
        }
    }

    private seedHierarchical(obj: any, currentRoot: string = "", currentPath: string = ""): void {
        for (const [name, value] of Object.entries(obj)) {
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                if (!currentRoot) {
                    // Top level is root (HKLM, HKCU, etc)
                    this.seedHierarchical(value, name, "");
                } else {
                    // Nested is a subkey
                    const newPath = currentPath ? `${currentPath}\\${name}` : name;
                    this.seedHierarchical(value, currentRoot, newPath);
                }
            } else {
                // It's a value for the current key
                if (currentRoot) {
                    const keyHandle = this.normalizeKey(currentRoot, currentPath);
                    let values = this.keys.get(keyHandle);
                    if (!values) {
                        values = new Map();
                        this.keys.set(keyHandle, values);
                    }
                    
                    const regValue: RegistryValue = {
                        name: name,
                        type: typeof value === "number" ? "REG_DWORD" : "REG_SZ",
                        data: value as string | number
                    };
                    values.set(name.toLowerCase(), regValue);
                }
            }
        }
    }

    open(root: string, path: string): string | null {
        const key = this.normalizeKey(root, path);
        if (this.keys.has(key)) return key;
        if (IMPLICIT_EMPTY_KEYS.has(key)) return key;
        if (this.defaults().has(key)) return key;
        // Support opening intermediate keys: if any stored key starts with this prefix,
        // the intermediate key implicitly exists (Windows registry semantics).
        const prefix = key + "\\";
        for (const k of [...this.keys.keys(), ...this.defaults().keys()]) {
            if (k.startsWith(prefix)) {
                // Create the intermediate key so future lookups are O(1)
                this.keys.set(key, new Map());
                return key;
            }
        }
        return null;
    }

    getValue(keyHandle: string, valueName: string): RegistryValue | null {
        const values = this.mergedValues(keyHandle);
        const value = values ? values.get(valueName.toLowerCase()) ?? null : null;

        // Log access
        this.logAccess({
            ts: Date.now(),
            op: "RegQueryValueEx",
            key: keyHandle,
            value: valueName,
            result: value ? "success" : "not_found",
            data: value?.data,
        });

        return value;
    }

    setValue(keyHandle: string, valueName: string, value: RegistryValue): void {
        let values = this.keys.get(keyHandle);
        if (!values) {
            values = new Map();
            this.keys.set(keyHandle, values);
        }
        values.set(valueName.toLowerCase(), value);

        // Log access
        this.logAccess({
            ts: Date.now(),
            op: "RegSetValueEx",
            key: keyHandle,
            value: valueName,
            result: "success",
            data: value.data,
        });

        // Notify change
        this.notifyChange();
    }

    createKey(root: string, path: string): { key: string; isNew: boolean } {
        const key = this.normalizeKey(root, path);
        const isNew = !this.keys.has(key);
        if (isNew) {
            this.keys.set(key, new Map());

            // Log access
            this.logAccess({
                ts: Date.now(),
                op: "RegCreateKeyEx",
                key: key,
                value: "",
                result: "success",
            });

            // Notify change
            this.notifyChange();
        }
        return { key, isNew };
    }

    deleteKey(baseKey: string, subKey?: string): boolean {
        const fullKey = this.resolveKey(baseKey, subKey);
        const toDelete: string[] = [];
        for (const key of this.keys.keys()) {
            if (key === fullKey || key.startsWith(`${fullKey}\\`)) {
                toDelete.push(key);
            }
        }
        if (toDelete.length === 0) {
            this.logAccess({
                ts: Date.now(),
                op: "RegDeleteKey",
                key: fullKey,
                value: "",
                result: "not_found",
            });
            return false;
        }

        for (const key of toDelete) {
            this.keys.delete(key);
        }

        this.logAccess({
            ts: Date.now(),
            op: "RegDeleteKey",
            key: fullKey,
            value: "",
            result: "success",
        });

        this.notifyChange();
        return true;
    }

    deleteValue(baseKey: string, valueName: string): boolean {
        const fullKey = this.resolveKey(baseKey);
        const values = this.keys.get(fullKey);
        if (!values) {
            this.logAccess({
                ts: Date.now(),
                op: "RegDeleteValue",
                key: fullKey,
                value: valueName,
                result: "not_found",
            });
            return false;
        }

        const deleted = values.delete(valueName.toLowerCase());
        this.logAccess({
            ts: Date.now(),
            op: "RegDeleteValue",
            key: fullKey,
            value: valueName,
            result: deleted ? "success" : "not_found",
        });

        if (deleted) {
            this.notifyChange();
        }
        return deleted;
    }

    enumValues(keyHandle: string): RegistryValue[] {
        const values = this.mergedValues(keyHandle);
        if (!values) return [];
        return Array.from(values.values());
    }

    getKeyInfo(keyHandle: string): { valueCount: number; maxValueNameLen: number; maxValueDataLen: number } {
        const values = this.mergedValues(keyHandle);
        if (!values) return { valueCount: 0, maxValueNameLen: 0, maxValueDataLen: 0 };

        let maxNameLen = 0;
        let maxDataLen = 0;
        for (const val of values.values()) {
            maxNameLen = Math.max(maxNameLen, val.name.length);
            if (val.type === "REG_DWORD") {
                maxDataLen = Math.max(maxDataLen, 4);
            } else if (val.type === "REG_BINARY" || val.type === "REG_MULTI_SZ") {
                maxDataLen = Math.max(maxDataLen, String(val.data).length / 2);
            } else {
                // REG_SZ — include null terminator byte
                maxDataLen = Math.max(maxDataLen, String(val.data).length + 1);
            }
        }
        return { valueCount: values.size, maxValueNameLen: maxNameLen, maxValueDataLen: maxDataLen };
    }

    enumSubKeys(baseKey: string): string[] {
        const fullKey = this.resolveKey(baseKey);
        const prefix = `${fullKey}\\`;
        const names = new Set<string>();

        for (const key of [...this.keys.keys(), ...this.defaults().keys()]) {
            if (!key.startsWith(prefix)) continue;
            const remainder = key.slice(prefix.length);
            const next = remainder.split("\\")[0];
            if (next) names.add(next);
        }

        const list = Array.from(names);
        list.sort();

        this.logAccess({
            ts: Date.now(),
            op: "RegEnumKeyEx",
            key: fullKey,
            value: "",
            result: list.length > 0 ? "success" : "not_found",
        });

        return list;
    }

    private normalizeKey(root: string, path: string): string {
        const cleanRoot = root.toUpperCase();
        const cleanPath = path.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
        return `${cleanRoot}\\${cleanPath}`.toLowerCase();
    }

    private resolveKey(baseKey: string, subKey?: string): string {
        const cleanBase = baseKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "").toLowerCase();
        if (!subKey) return cleanBase;
        const cleanSub = subKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
        if (!cleanSub) return cleanBase;
        if (cleanBase.includes("\\")) {
            return `${cleanBase}\\${cleanSub}`.toLowerCase();
        }
        return this.normalizeKey(cleanBase, cleanSub);
    }

    /**
     * Set the current game ID for persistence
     */
    setGameId(gameId: string): void {
        this.gameId = gameId;
    }

    /**
     * Set callback to be called when registry changes
     */
    setOnChange(callback: (() => void) | null): void {
        this.onChangeCallback = callback;
    }

    /**
     * Serialize current registry state for persistence
     */
    serialize(): PersistedRegistryState {
        const keysObj: Record<string, Record<string, { name: string; type: string; data: string | number }>> = {};

        for (const [keyPath, values] of this.keys.entries()) {
            const valuesObj: Record<string, { name: string; type: string; data: string | number }> = {};
            for (const [valueName, value] of values.entries()) {
                valuesObj[valueName] = {
                    name: value.name,
                    type: value.type,
                    data: value.data,
                };
            }
            keysObj[keyPath] = valuesObj;
        }

        return {
            version: 2,
            gameId: this.gameId,
            lastModified: Date.now(),
            keys: keysObj,
        };
    }

    /**
     * Restore registry state from persisted data
     */
    restore(state: PersistedRegistryState): void {
        for (const [keyPath, valuesObj] of Object.entries(state.keys)) {
            const values = new Map<string, RegistryValue>();
            for (const [valueName, valueData] of Object.entries(valuesObj)) {
                values.set(valueName.toLowerCase(), {
                    name: valueData.name,
                    type: validateRegType(valueData.type),
                    data: valueData.data,
                });
            }
            this.keys.set(keyPath, values);
        }
    }

    /**
     * Log registry access operation
     */
    private logAccess(entry: RegistryAccessLogEntry): void {
        // Add to buffer (ring buffer behavior)
        this.accessLogBuffer.push(entry);
        if (this.accessLogBuffer.length > this.MAX_LOG_BUFFER_SIZE) {
            this.accessLogBuffer.shift();
        }
    }

    /**
     * Notify change listeners
     */
    private notifyChange(): void {
        if (this.onChangeCallback) {
            this.onChangeCallback();
        }
    }

    /**
     * Flush access log buffer to OPFS
     */
    async flushAccessLog(): Promise<void> {
        if (this.accessLogBuffer.length === 0 || !this.gameId) {
            return;
        }

        const entries = [...this.accessLogBuffer];
        this.accessLogBuffer = [];

        await RegistryPersistence.appendAccessLog(this.gameId, entries);
    }

    /**
     * Get current access log buffer (for UI display)
     */
    getAccessLogBuffer(): RegistryAccessLogEntry[] {
        return [...this.accessLogBuffer];
    }
}
