import { RegistryPersistence, RegistryAccessLogEntry, PersistedRegistryState } from "./registry-persistence";
import { Logger, LogCategory } from "../../core/logger";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { redirectsForImage, validateRedirects, type ExeRegistryRedirect, type RegistryRedirect } from "@bottleship/formats/sdb";

export type RegistryValueType = "REG_SZ" | "REG_DWORD" | "REG_BINARY" | "REG_MULTI_SZ";

const VALID_REG_TYPES = new Set<string>(["REG_SZ", "REG_DWORD", "REG_BINARY", "REG_MULTI_SZ"]);
const IMPLICIT_EMPTY_KEYS = new Set<string>([
    "hkcu\\software",
    "hklm\\software",
]);

/** A predefined hive has ONE key space whichever spelling names it; advapi32 speaks the short
 *  form, so the long names fold onto it. */
const ROOT_ALIASES: Record<string, string> = {
    HKEY_CLASSES_ROOT: "HKCR",
    HKEY_CURRENT_USER: "HKCU",
    HKEY_LOCAL_MACHINE: "HKLM",
    HKEY_USERS: "HKU",
    HKEY_CURRENT_CONFIG: "HKCC",
    HKEY_PERFORMANCE_DATA: "HKPD",
    HKEY_DYN_DATA: "HKDD",
};

function canonicalRoot(root: string): string {
    const upper = root.toUpperCase();
    return ROOT_ALIASES[upper] ?? upper;
}

function trimSeparators(path: string): string {
    return path.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
}

/**
 * The form a key is stored under: short root, backslashes, no edge separators, lowercase.
 * `root` is a predefined root or a key handle (itself a stored key); a whole root is just
 * the root ("hklm"), never "hklm\".
 */
function keyOf(root: string, path: string): string {
    const cleanPath = path ? trimSeparators(path) : "";
    // A handle is already a clean stored key; anything else is trimmed first.
    const cleanBase = root.includes("/") || root.startsWith("\\") || root.endsWith("\\") ? trimSeparators(root) : root;
    const sep = cleanBase.indexOf("\\");
    const base = sep < 0 ? canonicalRoot(cleanBase) : canonicalRoot(cleanBase.slice(0, sep)) + cleanBase.slice(sep);
    return (cleanPath ? `${base}\\${cleanPath}` : base).toLowerCase();
}

/** "HKEY_LOCAL_MACHINE\Software\X" → ["HKEY_LOCAL_MACHINE", "Software\X"]. */
function splitKey(spec: string): [string, string] {
    const clean = spec.replace(/\//g, "\\").replace(/^\\+/, "");
    const sep = clean.indexOf("\\");
    return sep < 0 ? [clean, ""] : [clean.slice(0, sep), clean.slice(sep + 1)];
}

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

/**
 * One guest-visible registry write, in the vocabulary of the API that produced it.
 *
 * The Windows registry is system-wide: a child process writing HKCU writes the hive its
 * parent reads, and persistence belongs to the system, not to whichever process happened
 * to call RegSetValueEx. A child runs in its own worker with its own RegistryStore, so its
 * writes are forwarded up to the process that owns persistence (see setMutationSink).
 */
export type RegistryMutation =
    | { op: "setValue"; key: string; name: string; value: RegistryValue }
    | { op: "createKey"; root: string; path: string }
    | { op: "deleteKey"; key: string; subKey?: string }
    | { op: "deleteValue"; key: string; name: string };

/**
 * Which neighbour on the process tree a replayed mutation arrived from.
 *
 * The hive is one object shared by the whole tree, so a write has to reach every process
 * in it, not just the one that owns persistence. Each store relays an applied mutation to
 * every neighbour EXCEPT its origin; a process tree has no cycles, so that terminates —
 * without the exclusion a parent and its child trade one write forever.
 */
export type RegistryOrigin = { from: "owner" } | { from: "child"; id?: number };

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
    private mutationSink: ((mutation: RegistryMutation) => void) | null = null;
    private downstreamSink: ((mutation: RegistryMutation, exceptChildId?: number) => void) | null = null;
    private replayOrigin: RegistryOrigin | null = null;
    private readonly MAX_LOG_BUFFER_SIZE = 1000;
    /**
     * This process's VirtualRegistry redirects in stored-key form, longest source first.
     * Validated so that no target overlaps any source: see setRedirects.
     */
    private redirects: Array<{ from: string; under: string; to: string }> = [];

    reset(): void {
        this.keys.clear();
        this.redirects = [];
        this.systemDefaults = null;
        this.accessLogBuffer = [];
        this.gameId = "";
        this.onChangeCallback = null;
        this.mutationSink = null;
        this.downstreamSink = null;
        this.replayOrigin = null;
    }

    /** The system baseline, built on first use so it reflects the manifest's osVersion
     *  (applied after boot seeding) rather than the pre-manifest default. */
    private defaults(): Map<string, Map<string, RegistryValue>> {
        if (this.systemDefaults) return this.systemDefaults;
        const map = new Map<string, Map<string, RegistryValue>>();
        for (const seed of buildSystemDefaults(EmulatorConfig.getInstance().osVersion)) {
            const values = new Map<string, RegistryValue>();
            for (const value of seed.values) values.set(value.name.toLowerCase(), value);
            // The system's own keys are where the system keeps them, whichever process asks.
            map.set(keyOf(seed.root, seed.path), values);
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
        // A seed is the hive's own contents — what an installer left in the real registry — so
        // it lands where it names; a process's redirects only change what that process sees.
        if (seed.root && seed.path && Array.isArray(seed.values)) {
            const key = keyOf(seed.root, seed.path);
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
                    const keyHandle = keyOf(currentRoot, currentPath);
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
        const key = this.guestKey(root, path);
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

        this.emit({ op: "setValue", key: keyHandle, name: valueName, value });
        // Notify change
        this.notifyChange();
    }

    createKey(root: string, path: string): { key: string; isNew: boolean } {
        return this.createStoredKey(this.guestKey(root, path));
    }

    /** `key` is final (already redirected); what other processes replay is this key, not the
     *  name this process was given — their own redirects are theirs, not ours. */
    private createStoredKey(key: string): { key: string; isNew: boolean } {
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

            const [root, path] = splitKey(key);
            this.emit({ op: "createKey", root, path });
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

        this.emit({ op: "deleteKey", key: fullKey });
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
            this.emit({ op: "deleteValue", key: baseKey, name: valueName });
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

    /**
     * Windows' VirtualRegistry ADDREDIRECT for THIS process: a key the guest names under `from`
     * is the key at the same place under `to`, for opens, creates and writes alike.
     *
     * A redirect is applied exactly once, to the full name the guest gives (a predefined root
     * or a handle, plus a subkey path). A handle holds the final key, so a key opened through a
     * redirected handle already lies under a target; validation guarantees no target overlaps
     * any source, so nothing produced by a redirect is ever moved again — not by a relative
     * open, not by restore() (which never redirects), not by a replayed mutation (which carries
     * the final key). A handle opened ABOVE a source ("HKLM\Software") is the guest's own name,
     * and joining a subkey to it names the source, so that join is redirected, as on Windows.
     *
     * Invalid rules (see validateRedirects) are rejected with a log line. Returns the accepted
     * ones.
     */
    setRedirects(rules: ReadonlyArray<RegistryRedirect> | undefined): RegistryRedirect[] {
        const { accepted, rejected } = validateRedirects(rules ?? []);
        for (const { rule, reason } of rejected) {
            Logger.warn(LogCategory.SYSTEM, `Registry redirect ${rule?.from} -> ${rule?.to} rejected: ${reason}`);
        }
        this.redirects = accepted.map(({ from, to }) => ({ from, under: `${from}\\`, to }));
        return accepted.map(({ rule }) => ({ from: rule.from, to: rule.to }));
    }

    /**
     * Select the rules of the database entry that matches this process's image and apply them.
     * Matching is by the image's file name only (MATCHING_FILE attributes are not checked); an
     * image no entry names gets no redirects at all.
     */
    setRedirectsForImage(rules: ReadonlyArray<ExeRegistryRedirect> | undefined, imagePath: string): RegistryRedirect[] {
        const accepted = this.setRedirects(redirectsForImage(rules ?? [], imagePath));
        if (accepted.length > 0) {
            Logger.log(LogCategory.SYSTEM,
                `Registry redirects for ${imagePath}: ${accepted.map((r) => `${r.from} -> ${r.to}`).join(", ")}`);
        }
        return accepted;
    }

    /** The stored key a name the guest gives resolves to in this process. */
    private guestKey(root: string, path: string): string {
        const key = keyOf(root, path);
        if (this.redirects.length === 0) return key;
        for (const { from, under, to } of this.redirects) {
            if (key === from || key.startsWith(under)) return to + key.slice(from.length);
        }
        return key;
    }

    private resolveKey(baseKey: string, subKey?: string): string {
        const cleanBase = baseKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "").toLowerCase();
        if (!subKey) return cleanBase;
        const cleanSub = subKey.replace(/\//g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
        if (!cleanSub) return cleanBase;
        return this.guestKey(cleanBase, cleanSub);
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
     * Forward every guest write to the process that owns persistence.
     *
     * A child process gets its own worker and its own store, so without this its writes
     * live and die inside that worker: nothing there holds the gameId or the autosave the
     * root boot installed, and the settings a configurator writes on its way out are gone
     * before anyone could save them. The sink is the registry's half of what
     * createChildVfsClient already does for files.
     */
    setMutationSink(sink: ((mutation: RegistryMutation) => void) | null): void {
        this.mutationSink = sink;
    }

    /**
     * Forward every guest write DOWN to the live children of this process.
     *
     * The upward sink alone makes the hive one-way: a parent that writes while its child
     * runs is invisible to that child's copy, which on Windows is not a thing that can
     * happen. `exceptChildId` is the origin exclusion that keeps the relay finite.
     */
    setDownstreamSink(sink: ((mutation: RegistryMutation, exceptChildId?: number) => void) | null): void {
        this.downstreamSink = sink;
    }

    /** Replay a mutation forwarded from another process, as if this store's API produced it. */
    // A mutation with no stated origin came from below — that is the direction that
    // composes, so it keeps travelling up. An id-less child cannot be excluded from the
    // downward relay; the message route always supplies one.
    applyMutation(mutation: RegistryMutation, origin: RegistryOrigin = { from: "child" }): void {
        // Read back inside emit(), which the setters below reach synchronously.
        const outer = this.replayOrigin;
        this.replayOrigin = origin;
        try {
            switch (mutation.op) {
                case "setValue":
                    this.setValue(mutation.key, mutation.name, mutation.value);
                    break;
                case "createKey":
                    // The sender resolved the name with ITS redirects; replay the key it got.
                    this.createStoredKey(keyOf(mutation.root, mutation.path));
                    break;
                case "deleteKey":
                    this.deleteKey(mutation.key, mutation.subKey);
                    break;
                case "deleteValue":
                    this.deleteValue(mutation.key, mutation.name);
                    break;
            }
        } finally {
            this.replayOrigin = outer;
        }
    }

    /** Sink failures must not fail the guest's write — the local store is already correct. */
    private emit(mutation: RegistryMutation): void {
        const origin = this.replayOrigin;
        if (this.mutationSink && origin?.from !== "owner") {
            try {
                this.mutationSink(mutation);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `Registry mutation forward failed: ${e}`);
            }
        }
        if (this.downstreamSink) {
            try {
                this.downstreamSink(mutation, origin?.from === "child" ? origin.id : undefined);
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `Registry mutation relay to children failed: ${e}`);
            }
        }
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
            // Persisted keys are final: a redirect already happened when the guest named them.
            const key = keyPath.includes("\\") ? keyOf(keyPath, "") : keyPath;
            const existing = this.keys.get(key);
            if (existing) for (const [n, v] of values) existing.set(n, v);
            else this.keys.set(key, values);
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
     * Commit this store to its container NOW.
     *
     * The autosave is debounced, so a process that writes its settings and calls
     * ExitProcess in the same breath exits inside that window — the durability barrier
     * awaits this so the write lands before the host is told the process is gone. A store
     * with no gameId owns no container: that is a child's copy, and its writes reach disk
     * through the owner it forwards them to, not from here.
     */
    async flush(): Promise<void> {
        if (!this.gameId) return;
        await RegistryPersistence.save(this.gameId, this.serialize());
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
