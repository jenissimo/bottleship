/** A new installer import has one guest installation root shared by files and metadata. */
import { payloadPath } from "@bottleship/formats/installer/binary";
import { parseGogGameInfo, synthesizeManifest, type SynthOptions } from "./manifest-synth";

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** WGB ROM maps to C:. Refuse ambiguous Win32 spellings instead of normalizing escapes. */
export function normalizeInstallDir(value: string): string {
    const path = value.replace(/\//g, "\\");
    if (!/^c:\\/i.test(path)) throw new Error("Install directory must be an absolute C:\\ path");
    const tail = path.slice(3).replace(/\\$/, "");
    if (!tail) return "C:\\";
    const parts = tail.split("\\");
    for (const part of parts) {
        if (!part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)
            || /[. ]$/.test(part) || RESERVED.test(part)) throw new Error("Unsafe install directory");
    }
    return "C:\\" + parts.join("\\");
}

function defaultInstallDir(opts: SynthOptions): string {
    const gog = parseGogGameInfo(opts.gameFiles);
    if (gog.gameId && /^\d+$/.test(gog.gameId)) return "C:\\Games\\gog-" + gog.gameId;
    // No product id: installer identity, not the editable/localized wizard display name.
    const name = opts.parsed.header.appName || opts.cli?.exe || "game";
    const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "game";
    return "C:\\Games\\app-" + slug;
}

/** Keep already absolute DOS paths intentional; relative metadata is installation-relative. */
export function installerGuestPath(installDir: string, relative: string): string {
    const expanded = relative.replace(/\{app\}/gi, installDir.replace(/\\$/, "")).replace(/\//g, "\\");
    if (/^[a-z]:\\/i.test(expanded)) return expanded;
    if (expanded === "." || expanded === "") return installDir;
    return installDir.replace(/\\$/, "") + "\\" + payloadPath(expanded).replace(/\//g, "\\");
}

export function synthesizeInstallerManifest(opts: SynthOptions) {
    // --reg-install historically changed registry only. An existing explicit recipe keeps
    // root payload layout unless it also opts into --install-dir.
    const installDir = normalizeInstallDir(opts.cli?.installDir
        ?? (opts.cli?.regInstall !== undefined ? "C:\\" : defaultInstallDir(opts)));
    const romPrefix = "rom/" + (installDir.length > 3 ? installDir.slice(3).replace(/\\/g, "/") + "/" : "");
    const synth = synthesizeManifest({ ...opts, cli: { ...opts.cli, regInstall: opts.cli?.regInstall ?? installDir } });
    const entry = String(synth.manifest.entrypoint);
    if (!entry.startsWith("rom/")) throw new Error("Installer entrypoint must be below rom/");
    synth.manifest.entrypoint = romPrefix + payloadPath(entry.slice(4));
    const emulator = synth.manifest.emulator as Record<string, unknown>;
    if (installDir.length > 3 && Array.isArray(emulator.createDirs)) {
        emulator.createDirs = emulator.createDirs.map(p => installerGuestPath(installDir, String(p)));
    }
    // The loader otherwise uses the executable's folder. Only an authoritative task/
    // shortcut cwd overrides it; explicit curated absolute cwd remains unchanged.
    if (opts.cli?.appDirDlls) emulator.appDirDlls = [...opts.cli.appDirDlls];
    const gog = parseGogGameInfo(opts.gameFiles);
    const icon = !opts.cli?.exe && !gog.exe
        ? opts.parsed.icons?.find(i => /\{app\}/i.test(i.filename)) : undefined;
    const cwd = emulator.workingDir ?? gog.workingDir ?? icon?.workingDir;
    if (typeof cwd === "string" && cwd && !cwd.replace(/\{app\}/gi, "").includes("{")) {
        emulator.workingDir = installerGuestPath(installDir, cwd);
    }
    return { ...synth, installDir, romPrefix };
}
