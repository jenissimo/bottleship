/**
 * Generic Unreal Engine 1 first-run support.
 *
 * UE1 games (Unreal, UT, Deus Ex, …) ship factory config
 * templates (`System/Default.ini`, `System/DefUser.ini`) and lazily create the
 * active config (e.g. `HP.ini` / `User.ini`) by copying a template the first
 * time it is needed. A render-detection step is expected to leave a
 * `Detected.ini` (+ `Detected.log`) which the game then READS (OPEN_EXISTING)
 * and STALLS on if it is missing.
 *
 * The active config dir is baked into the exe (HP redirects to
 * `C:\My Documents\<GameFolder>\`), unknown at bundle-build time. So instead of
 * per-game manifest hacks (shellExecFake/writeFiles), this layer reacts at the
 * file-open layer: it learns the user dir from the game's own request, then
 * materializes/seeds the missing files into the CoW overlay.
 *
 * This module holds the PURE, unit-tested pieces (no VFS/System deps). The
 * reactive CreateFile* handler lives in kernel32/file-io.ts and the boot-time
 * Default.ini pin lives in emulator.worker.ts; both gate on the `ue1` flag set
 * by detectUe1() at bundle load.
 */

/** RenderDevice we want every UE1 config to use — our D3D7→WebGPU path. */
export const UE1_RENDER_DEVICE = "D3DDrv.D3DRenderDevice";

/** [Engine.Engine] keys that select the renderer. All must point at our device. */
const RENDER_DEVICE_KEYS = ["GameRenderDevice", "WindowedRenderDevice", "RenderDevice"] as const;

/**
 * UE1 detection predicate (pure). A bundle is UE1 if its filesystem has the
 * engine's Core + Engine packages — either the compiled DLLs (older VC6 builds)
 * or the `.u` script packages (every UE1 build ships these in System/).
 *
 * `exists` is a case-insensitive existence check for a guest path (drive-rooted,
 * e.g. "C:\\System\\Core.dll"); callers wire it to vfs.getFileSize(p) > 0 or a
 * ROM-index probe. Gating EVERYTHING below on this keeps non-UE1 games untouched.
 */
export function detectUe2PcPackages(exists: (guestPath: string) => boolean): boolean {
    return exists("C:\\System\\PC\\gui.u") || exists("C:\\System\\PC\\xidinterf.u");
}

export function detectUe1(exists: (guestPath: string) => boolean): boolean {
    const has = (rel: string) => exists(`C:\\${rel}`);
    const hasDlls = has("System\\Core.dll") && has("System\\Engine.dll");
    const hasPackages = has("System\\Core.u") && has("System\\Engine.u");
    return hasDlls || hasPackages;
}

/**
 * UE1's render-device probe (pure): the engine tests a renderer by launching its OWN image
 * with `testrendev=<class> log=Detected.log` (older builds also use `-b false`). The child's
 * entire contract is the Detected.ini/Detected.log it leaves behind — the parent neither
 * waits on it nor reads its exit code — so a no-op virtual child plus the reactive
 * materialization above IS the observable effect.
 *
 * It must never be served as a self re-exec. A re-exec restarts the game WITH the probe's
 * command line, which makes the probe be the game: a `testrendev=` run initializes the
 * renderer, writes its log and exits, so the title "starts and immediately quits" with a
 * clean exit(0) and no fault anywhere to point at.
 */
export function isUe1RenderProbeCommandLine(commandLine: string): boolean {
    return /(?:^|\s)testrendev\s*=/i.test(commandLine)
        || /(?:^|\s)-b\s+false(?:\s|$)/i.test(commandLine);
}

/**
 * Reactive-handler classification of a requested filename (pure).
 *  - "detected": basename is Detected.ini / Detected.log — materialize empty,
 *    and the containing dir becomes the UE1 user dir.
 *  - "user-ini": basename is User.ini — seed from System/DefUser.ini.
 *  - "ini": some other *.ini in the user dir — seed from System/Default.ini
 *    (through pinUe1RenderDevice).
 *  - null: not a file we touch.
 *
 * `inUserDir` tells whether the requested path lives in the already-learned
 * UE1 user dir; a generic *.ini only seeds when true (Detected.* is recognized
 * regardless, since opening it is what teaches us the user dir).
 */
export type Ue1FileKind = "detected" | "user-ini" | "ini";

export function classifyUe1FirstRunFile(basename: string, inUserDir: boolean): Ue1FileKind | null {
    const lower = basename.toLowerCase();
    if (lower === "detected.ini" || lower === "detected.log") return "detected";
    if (!inUserDir) return null;
    if (lower === "user.ini") return "user-ini";
    if (lower.endsWith(".ini")) return "ini";
    return null;
}

/** Directory portion of a Windows path (no trailing slash); "" if none. */
export function dirOfWindowsPath(fullPath: string): string {
    const norm = fullPath.replace(/\//g, "\\");
    const idx = norm.lastIndexOf("\\");
    return idx <= 0 ? "" : norm.slice(0, idx);
}

/** Basename of a Windows path. */
export function baseOfWindowsPath(fullPath: string): string {
    const norm = fullPath.replace(/\//g, "\\");
    const idx = norm.lastIndexOf("\\");
    return idx < 0 ? norm : norm.slice(idx + 1);
}

interface IniSection {
    /** Section header line as written, e.g. "[Engine.Engine]" (no header for the preamble). */
    header: string | null;
    lines: string[];
}

/** Parse an INI into ordered sections, preserving every line verbatim. */
function parseIniSections(iniText: string): IniSection[] {
    const sections: IniSection[] = [{ header: null, lines: [] }];
    const rawLines = iniText.split(/\r\n|\n|\r/);
    for (const line of rawLines) {
        const m = line.match(/^\s*\[(.+?)\]\s*$/);
        if (m) {
            sections.push({ header: line, lines: [] });
        } else {
            sections[sections.length - 1].lines.push(line);
        }
    }
    return sections;
}

/** True if a section header names "[Engine.Engine]" (case-insensitive). */
function isEngineEngineHeader(header: string | null): boolean {
    if (!header) return false;
    const m = header.match(/^\s*\[(.+?)\]\s*$/);
    return m ? m[1].trim().toLowerCase() === "engine.engine" : false;
}

/** Match a `Key=Value` line (case-insensitive on key); returns the value or null. */
function keyOfLine(line: string): string | null {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    return m ? m[1] : null;
}

/** Value portion of a `Key=Value` line, or null if not a key line. */
function valueOfLine(line: string): string | null {
    const m = line.match(/^\s*[A-Za-z0-9_]+\s*=\s*(.*)$/);
    return m ? m[1].trim() : null;
}

function serializeIniSections(sections: IniSection[], eol: string): string {
    const out: string[] = [];
    for (const s of sections) {
        if (s.header !== null) out.push(s.header);
        for (const line of s.lines) out.push(line);
    }
    return out.join(eol);
}

/**
 * Force-feedback: DO NOT touch a UE2 title's ForceFeedbackManager config.
 *
 * Ground truth from a retail XIII install: its active `XIII.ini` (and the factory
 * `Default.ini`) ship NO `ForceFeedbackManager` line at all, and the game runs — the
 * engine handles the unconfigured case (the class var defaults to None and FF init is
 * skipped). An earlier build of this pin WRONGLY injected a value, which is the only
 * reason the engine ever tried to construct one:
 *   - `Engine.ForceFeedbackManager` is the ABSTRACT base (CLASS_Abstract) →
 *     StaticAllocateObject fatally errors "class ForceFeedbackManager is abstract".
 *   - `Engine.ForceFeedbackController` is not a loadable UClass → NULL class →
 *     "Empty class for object … StaticAllocateObject <- (NULL)".
 * Either way: unhandled C++ throw → abort() → MSVC "Runtime Error!" dialog.
 *
 * So we NEVER inject, and we self-heal an overlay a prior build poisoned by stripping
 * exactly those two injected values (a real game's own concrete value, if any, is left
 * intact). This matches real-hardware behavior — the faithful, generic outcome.
 */
const FF_INJECTED_VALUES = new Set([
    "engine.forcefeedbackmanager",
    "engine.forcefeedbackcontroller",
]);

const FORCE_FEEDBACK_MANAGER_KEY = "ForceFeedbackManager";

export function pinUe2ForceFeedbackManager(iniText: string): string {
    const useCrlf = iniText.includes("\r\n");
    const eol = useCrlf ? "\r\n" : "\n";
    const sections = parseIniSections(iniText);
    const engineIdx = sections.findIndex((s) => isEngineEngineHeader(s.header));
    if (engineIdx === -1) return iniText;

    const section = sections[engineIdx];
    let changed = false;
    const kept = section.lines.filter((line) => {
        if (keyOfLine(line)?.toLowerCase() !== FORCE_FEEDBACK_MANAGER_KEY.toLowerCase()) return true;
        const v = valueOfLine(line)?.toLowerCase() ?? "";
        if (FF_INJECTED_VALUES.has(v)) { changed = true; return false; } // strip our poison
        return true;
    });
    if (!changed) return iniText;
    section.lines = kept;
    return serializeIniSections(sections, eol);
}

/** Boot/seed INI pin: D3D render device (UE1) + UE2 WinDrv force-feedback manager. */
export const UE2_PC_PACKAGES_PATH = String.raw`..\System\PC\*.u`;

function isCoreSystemHeader(header: string | null): boolean {
    if (!header) return false;
    const m = header.match(/^\s*\[(.+?)\]\s*$/);
    return m ? m[1].trim().toLowerCase() === "core.system" : false;
}

function hasIniPathLine(section: IniSection, wantedValue: string): boolean {
    const want = wantedValue.replace(/\\/g, "/").toLowerCase();
    for (const line of section.lines) {
        const key = keyOfLine(line);
        if (key?.toLowerCase() !== "paths") continue;
        const value = valueOfLine(line);
        if (value && value.replace(/\\/g, "/").toLowerCase() === want) return true;
    }
    return false;
}

/**
 * UE2 PC ports (XIII, etc.) ship gameplay packages under System\PC\ but factory
 * Default.ini only lists ..\System\*.u — XIDInterf.u / gui.u never resolve.
 */
export function pinUe2PcPackagePath(iniText: string): string {
    const useCrlf = iniText.includes("\r\n");
    const eol = useCrlf ? "\r\n" : "\n";
    const sections = parseIniSections(iniText);
    const coreIdx = sections.findIndex((s) => isCoreSystemHeader(s.header));
    if (coreIdx === -1) return iniText;

    const section = sections[coreIdx];
    if (hasIniPathLine(section, UE2_PC_PACKAGES_PATH)) return iniText;

    let insertAt = section.lines.length;
    while (insertAt > 0 && section.lines[insertAt - 1].trim() === "") insertAt--;
    // Insert after the last existing Paths= line so we stay with the path group.
    for (let i = section.lines.length - 1; i >= 0; i--) {
        if (keyOfLine(section.lines[i])?.toLowerCase() === "paths") {
            insertAt = i + 1;
            break;
        }
    }
    section.lines.splice(insertAt, 0, `Paths=${UE2_PC_PACKAGES_PATH}`);
    return serializeIniSections(sections, eol);
}

export function pinUeEngineIni(iniText: string, options?: { hasPcPackages?: boolean }): string {
    let out = pinUe2ForceFeedbackManager(pinUe1RenderDevice(iniText));
    if (options?.hasPcPackages) {
        out = pinUe2PcPackagePath(out);
    }
    return out;
}

/**
 * Ensure a UE1 INI selects our D3D render device (pure, idempotent).
 *
 * Guarantees that `[Engine.Engine]` contains
 *   GameRenderDevice=D3DDrv.D3DRenderDevice
 *   WindowedRenderDevice=D3DDrv.D3DRenderDevice
 *   RenderDevice=D3DDrv.D3DRenderDevice
 * adding the section/keys if missing, and REPLACING any existing value that
 * points elsewhere (SoftDrv.SoftwareRenderDevice, Engine.NullRenderDevice,
 * OpenGLDrv/GlideDrv, …). Every other line — sections, comments, blank lines,
 * unrelated keys — is preserved verbatim. The line ending of the source is kept
 * (CRLF if the source used it anywhere, else LF), matching UE1's own writer.
 */
export function pinUe1RenderDevice(iniText: string): string {
    const useCrlf = iniText.includes("\r\n");
    const eol = useCrlf ? "\r\n" : "\n";
    const wanted = new Map(RENDER_DEVICE_KEYS.map((k) => [k.toLowerCase(), `${k}=${UE1_RENDER_DEVICE}`]));

    const sections = parseIniSections(iniText);
    let engineIdx = sections.findIndex((s) => isEngineEngineHeader(s.header));

    if (engineIdx === -1) {
        // No [Engine.Engine] — append a fresh section with all three keys.
        sections.push({
            header: "[Engine.Engine]",
            lines: RENDER_DEVICE_KEYS.map((k) => `${k}=${UE1_RENDER_DEVICE}`),
        });
        engineIdx = sections.length - 1;
    } else {
        const section = sections[engineIdx];
        const seen = new Set<string>();
        for (let i = 0; i < section.lines.length; i++) {
            const key = keyOfLine(section.lines[i]);
            if (!key) continue;
            const lk = key.toLowerCase();
            const replacement = wanted.get(lk);
            if (replacement !== undefined) {
                section.lines[i] = replacement; // replace SoftDrv/Null/etc. with our device
                seen.add(lk);
            }
        }
        // Add any render-device key that wasn't present. Insert after the last
        // non-empty line so the keys land inside the section, not after trailing blanks.
        let insertAt = section.lines.length;
        while (insertAt > 0 && section.lines[insertAt - 1].trim() === "") insertAt--;
        const toAdd: string[] = [];
        for (const k of RENDER_DEVICE_KEYS) {
            if (!seen.has(k.toLowerCase())) toAdd.push(`${k}=${UE1_RENDER_DEVICE}`);
        }
        section.lines.splice(insertAt, 0, ...toAdd);
    }

    return serializeIniSections(sections, eol);
}
