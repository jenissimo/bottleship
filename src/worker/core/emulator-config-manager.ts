import { WgbManifest, WgbWriteFileSpec } from "../runtime/filesystem/wgb-loader";
import { Logger, LogCategory } from "./logger";
import {
    EMU_MEMORY_SIZE,
    EMU_D3D_DEFAULT_CAPS,
    EMU_DDRAW_DEFAULT_CAPS,
    MEM_SURFACE_BASE,
} from "./cpu/emulator-config";
import { QualityConfig, DEFAULT_QUALITY, mergeQuality } from "./quality-config";
import { asBufferSource } from "../../dom-buffer";

// OS Version constants
export const VER_PLATFORM_WIN32_WINDOWS = 0x1;
export const VER_PLATFORM_WIN32_NT = 0x2;

// Default OS version (Windows 98)
const DEFAULT_OS_VERSION = {
    major: 4,
    minor: 10,
    build: 1998,
    platformId: VER_PLATFORM_WIN32_WINDOWS,
};

const DEFAULT_DISPLAY_REFRESH_RATE = 60;

type DisplayModeConfig = {
    width: number;
    height: number;
    bpp: number;
    refreshRate: number;
};

type DisplayModeInput = {
    width: number;
    height: number;
    bpp?: number;
    refreshRate?: number;
    refresh?: number;
};

function normalizeRefreshRate(refreshRate: number | undefined): number {
    const hz = Number(refreshRate);
    return Number.isFinite(hz) && hz > 0 ? Math.trunc(hz) : DEFAULT_DISPLAY_REFRESH_RATE;
}

// Default screen resolution
const DEFAULT_SCREEN_RESOLUTION: DisplayModeConfig = {
    width: 1024,
    height: 768,
    bpp: 16,
    refreshRate: DEFAULT_DISPLAY_REFRESH_RATE,
};

// Default screen background (letterbox) color: black
const DEFAULT_SCREEN_BACKGROUND = { r: 0, g: 0, b: 0, a: 1 };

// Standard display modes reported by EnumDisplayModes.
// Covers common Win95/98-era resolutions at 8, 16, and 32 bpp.
const DEFAULT_DISPLAY_MODE_SPECS: Array<Omit<DisplayModeConfig, "refreshRate">> = [
    // 8bpp (256 color) modes — required by many DOS-era ports and older DDraw games
    { width: 320, height: 200, bpp: 8 },
    { width: 320, height: 240, bpp: 8 },
    { width: 640, height: 400, bpp: 8 },
    { width: 640, height: 480, bpp: 8 },
    { width: 800, height: 600, bpp: 8 },
    // 16bpp modes — the sweet spot for most late-90s 3D games
    { width: 320, height: 200, bpp: 16 },
    { width: 320, height: 240, bpp: 16 },
    { width: 512, height: 384, bpp: 16 },
    { width: 640, height: 400, bpp: 16 },
    { width: 640, height: 480, bpp: 16 },
    { width: 800, height: 600, bpp: 16 },
    { width: 1024, height: 768, bpp: 16 },
    { width: 1152, height: 864, bpp: 16 },
    { width: 1280, height: 960, bpp: 16 },
    { width: 1280, height: 1024, bpp: 16 },
    { width: 1600, height: 1200, bpp: 16 },
    // 32bpp modes — newer DDraw7/D3D7 titles
    { width: 640, height: 480, bpp: 32 },
    { width: 800, height: 600, bpp: 32 },
    { width: 1024, height: 768, bpp: 32 },
    { width: 1152, height: 864, bpp: 32 },
    { width: 1280, height: 960, bpp: 32 },
    { width: 1280, height: 1024, bpp: 32 },
    { width: 1600, height: 1200, bpp: 32 },
    // 16:9 widescreen — native fit for Full HD / 4K panels (integer-scale friendly)
    { width: 1280, height: 720, bpp: 32 },
    { width: 1920, height: 1080, bpp: 32 },
];

const DEFAULT_DISPLAY_MODES: DisplayModeConfig[] = DEFAULT_DISPLAY_MODE_SPECS.map((mode) => ({
    ...mode,
    refreshRate: DEFAULT_DISPLAY_REFRESH_RATE,
}));

// Map Windows code page numbers to TextDecoder encoding labels.
// Only labels in the WHATWG Encoding spec work with TextDecoder. Notable gaps:
// CP437, CP850, CP852, CP855, CP857, CP860-865 — handled via LUT below.
const CP_TO_ENCODING: Record<number, string> = {
    866: 'ibm866',
    874: 'windows-874',
    1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
    1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
    1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
    28591: 'iso-8859-1', 28592: 'iso-8859-2', 28595: 'iso-8859-5',
    65001: 'utf-8',
};

// CP437 (US OEM / IBM PC) — upper 128 code points (0x80–0xFF).
// Lower 128 are identity-mapped ASCII.
const CP437_UPPER: readonly number[] = [
    0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7, 0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
    0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9, 0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192,
    0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA, 0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
    0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F, 0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B, 0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
    0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4, 0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229,
    0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248, 0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0,
];

// CP850 (Western European OEM / Multilingual Latin-1).
const CP850_UPPER: readonly number[] = [
    0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7, 0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
    0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9, 0x00FF, 0x00D6, 0x00DC, 0x00F8, 0x00A3, 0x00D8, 0x00D7, 0x0192,
    0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA, 0x00BF, 0x00AE, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00C1, 0x00C2, 0x00C0, 0x00A9, 0x2563, 0x2551, 0x2557, 0x255D, 0x00A2, 0x00A5, 0x2510,
    0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x00E3, 0x00C3, 0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x00A4,
    0x00F0, 0x00D0, 0x00CA, 0x00CB, 0x00C8, 0x0131, 0x00CD, 0x00CE, 0x00CF, 0x2518, 0x250C, 0x2588, 0x2584, 0x00A6, 0x00CC, 0x2580,
    0x00D3, 0x00DF, 0x00D4, 0x00D2, 0x00F5, 0x00D5, 0x00B5, 0x00FE, 0x00DE, 0x00DA, 0x00DB, 0x00D9, 0x00FD, 0x00DD, 0x00AF, 0x00B4,
    0x00AD, 0x00B1, 0x2017, 0x00BE, 0x00B6, 0x00A7, 0x00F7, 0x00B8, 0x00B0, 0x00A8, 0x00B7, 0x00B9, 0x00B3, 0x00B2, 0x25A0, 0x00A0,
];

const CP_TO_LUT: Record<number, readonly number[]> = {
    437: CP437_UPPER,
    850: CP850_UPPER,
};

/**
 * LUT-backed decoder for single-byte code pages that browsers don't ship
 * (CP437, CP850, etc.). Structurally compatible with TextDecoder.decode().
 */
class LutDecoder {
    private readonly table: Uint16Array;
    constructor(upper128: readonly number[]) {
        const t = new Uint16Array(256);
        for (let i = 0; i < 128; i++) t[i] = i;
        for (let i = 0; i < 128; i++) t[128 + i] = upper128[i];
        this.table = t;
    }
    decode(input?: BufferSource): string {
        if (!input) return '';
        const u8 = input instanceof Uint8Array
            ? input
            : ArrayBuffer.isView(input)
                ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                : new Uint8Array(input as ArrayBuffer);
        let out = '';
        const t = this.table;
        for (let i = 0; i < u8.length; i++) out += String.fromCharCode(t[u8[i]]);
        return out;
    }
}

// A decoder interface that both TextDecoder and LutDecoder satisfy.
// (TextDecoder.decode accepts more overloads; this is the subset we use.)
export type CodePageDecoder = { decode(input?: BufferSource): string };

// Cached decoder instances per codepage
const decoderCache = new Map<number, CodePageDecoder>();

// Cached reverse encoding tables (unicode codepoint → byte) per codepage
const encoderCache = new Map<number, Map<number, number>>();

/**
 * Get a decoder for the given Windows code page.
 * Falls back to windows-1252 for unknown code pages.
 * Uses a LUT-backed decoder for DOS code pages the browser doesn't support.
 */
export function getCodePageDecoder(codePage: number): CodePageDecoder {
    let decoder = decoderCache.get(codePage);
    if (!decoder) {
        const lut = CP_TO_LUT[codePage];
        if (lut) {
            decoder = new LutDecoder(lut);
        } else {
            const label = CP_TO_ENCODING[codePage] ?? 'windows-1252';
            decoder = new TextDecoder(label);
        }
        decoderCache.set(codePage, decoder);
    }
    return decoder;
}

/**
 * Decode an ANSI (code page) byte string from guest memory.
 */
export function decodeAnsiString(mem: Uint8Array, addr: number, len: number, codePage: number): string {
    return getCodePageDecoder(codePage).decode(asBufferSource(mem.subarray(addr, addr + len)));
}

/**
 * Build a reverse encoding table for a single-byte code page.
 * Maps Unicode code points → byte values.
 */
function buildReverseTable(codePage: number): Map<number, number> {
    const decoder = getCodePageDecoder(codePage);
    const table = new Map<number, number>();
    // Decode all 256 byte values to get the full mapping
    const bytes = new Uint8Array(1);
    for (let b = 0; b < 256; b++) {
        bytes[0] = b;
        const ch = decoder.decode(bytes);
        const cp = ch.codePointAt(0)!;
        // Only map non-replacement characters
        if (cp !== 0xFFFD) {
            table.set(cp, b);
        }
    }
    return table;
}

/**
 * Encode a JS string to a single-byte code page buffer.
 * Returns a Uint8Array. Characters not in the code page are replaced with '?'.
 */
export function encodeAnsiString(str: string, codePage: number): Uint8Array {
    // UTF-8 fast path
    if (codePage === 65001) {
        return new TextEncoder().encode(str);
    }
    let table = encoderCache.get(codePage);
    if (!table) {
        table = buildReverseTable(codePage);
        encoderCache.set(codePage, table);
    }
    const result = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        const cp = str.codePointAt(i)!;
        result[i] = table.get(cp) ?? 0x3F; // '?' for unmappable
    }
    return result;
}

/**
 * Emulator configuration manager
 * Stores and manages emulator parameters that can be overridden via manifest
 */
export class EmulatorConfig {
    private static instance: EmulatorConfig | null = null;

    // OS Version configuration
    public osVersion = { ...DEFAULT_OS_VERSION };

    // Screen resolution configuration
    public screenResolution = { ...DEFAULT_SCREEN_RESOLUTION };

    // Supported resolutions for EnumDisplayModes.
    // Auto-generated from DEFAULT_DISPLAY_MODES if not overridden by manifest.
    public supportedResolutions: DisplayModeConfig[] = [...DEFAULT_DISPLAY_MODES];

    // Screen background color (for letterboxing/clearing)
    public screenBackgroundColor = { ...DEFAULT_SCREEN_BACKGROUND };

    // Memory configuration
    public memory = {
        ram: EMU_MEMORY_SIZE,
        vram: EMU_DDRAW_DEFAULT_CAPS.dwVidMemTotal,
    };

    // D3D Caps (merged with defaults)
    public d3dCaps = { ...EMU_D3D_DEFAULT_CAPS };

    // DDraw Caps (merged with defaults)
    public ddrawCaps = { ...EMU_DDRAW_DEFAULT_CAPS };

    // Graphics quality enhancements (AF, gamma/brightness/contrast/sat, scaling, post-FX).
    // NEUTRAL by default — a fresh config reproduces exact pre-feature behavior.
    // Treated as a GLOBAL user preference (like hleLibs): the host pushes the user's
    // saved settings via set_quality, and a per-game manifest.emulator.quality layers
    // on top at load. Intentionally NOT cleared by reset() (see note there).
    public quality: QualityConfig = { ...DEFAULT_QUALITY };

    // Skip video playback (BinkOpen/SmackOpen return stubs)
    public skipVideo = false;

    // Strict x87 FPU: boot with relaxed-FPU (f64 fast path) DISABLED so all FPU runs at
    // full 80-bit extended precision. For titles whose code is precision-sensitive at the
    // default PC=64 control word — e.g. OGG Vorbis / float audio codecs whose MDCT/synthesis
    // diverges under the f64 relaxed path and corrupts decode (NatalieBrooksSTH). Generic
    // capability (any bundle may declare it); mirrors real per-process x87 precision policy.
    public fpuStrict = false;

    // ANSI code page (GetACP) — default 1252 (Western European)
    public ansiCodePage = 1252;

    // OEM code page (GetOEMCP) — default 437 (US IBM)
    public oemCodePage = 437;

    // LCID (locale identifier) — default 0x0409 (English US)
    public lcid = 0x0409;

    // Per-game deny-list for LoadLibrary* (case-insensitive; wildcard allowed)
    public disabledDlls: string[] = [];

    // Fake ShellExecuteA subprocess results
    public shellExecFake: Array<{
        match: string;
        createFiles: Array<{ path: string; content?: string; copyFrom?: string; ifAbsent?: boolean }>;
    }> = [];

    // Unreal Engine 1 first-run support (set at bundle load by detectUe1()).
    // Gates the generic UE1 config seeding (Default.ini D3D pin + reactive
    // Detected.ini / config-ini materialization in CreateFile*). Detection keys
    // on System/Core+Engine packages, so non-UE1 games leave this false and are
    // completely unaffected. Reset to false on every boot (see reset()).
    public ue1 = false;

    // Learned UE1 "user dir" — the directory the game reads its active config and
    // Detected.ini from (baked into the exe; e.g. C:\My Documents\Hp demo). Set
    // reactively the first time Detected.ini/Detected.log is opened. null until learned.
    public ue1UserDir: string | null = null;

    // VFS paths to delete from CoW overlay on every boot
    public deleteOnBoot: string[] = [];

    // Files written into the VFS on every boot (data-driven per-game config overrides)
    public writeFiles: WgbWriteFileSpec[] = [];

    // Directories mkdir-p'd in the VFS on every boot (installer-created empty dirs
    // that store-only ZIP packing loses; e.g. Max Payne's <install>\data tree)
    public createDirs: string[] = [];

    /**
     * Guarded Inner-Loop HLE — signature-detects known
     * engine/library code in loaded PE images and hooks pure-compute leaf
     * functions with semantically-equivalent host kernels. Every shadow-enabled
     * hook validates itself against the original guest function for its first N
     * calls (differential mode) and permanently self-disables on any mismatch.
     * Per-lib keys are indexed by descriptor id, e.g. `simex: { enable: false }`.
     * The zlib/libpng/libjpeg static-lib hooks were removed as off the hot path.
     */
    public hleLibs: {
        enable: boolean;
        /** Detect + log matches but do NOT patch guest code. Safe dry-run. */
        logOnly: boolean;
        /** Override descriptor's own `minConfidence`. */
        minConfidence?: number;
        galaxy?: { enable?: boolean; hleAudio?: boolean; hleMixer?: boolean };
        /** Per-descriptor opt-out, keyed by descriptor id. */
        [libId: string]: unknown;
    } = {
        // ON by default: detection
        // is byte-exact per title, non-matching PEs score 0 and are a no-op;
        // every hook shadow-validates itself against the original for its first
        // N calls and permanently self-disables on any mismatch.
        enable: true,
        logOnly: false,
        /** Galaxy full-module HLE — opt-in via load_bundle { galaxyHle: true }. */
        galaxy: { enable: false, hleAudio: false, hleMixer: true },
    };

    private constructor() {
        // Private constructor for singleton
    }

    static getInstance(): EmulatorConfig {
        if (!EmulatorConfig.instance) {
            EmulatorConfig.instance = new EmulatorConfig();
        }
        return EmulatorConfig.instance;
    }

    /**
     * Apply configuration from manifest
     * Validates and applies overrides from manifest.emulator section
     */
    applyFromManifest(manifest: WgbManifest): void {
        if (!manifest.emulator) {
            return;
        }

        const config = manifest.emulator;

        // Apply OS version override
        if (config.osVersion) {
            this.osVersion = {
                major: config.osVersion.major ?? this.osVersion.major,
                minor: config.osVersion.minor ?? this.osVersion.minor,
                build: config.osVersion.build ?? this.osVersion.build,
                platformId: config.osVersion.platformId ?? this.osVersion.platformId,
            };
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: OS version set to ${this.osVersion.major}.${this.osVersion.minor} (build ${this.osVersion.build}, platform ${this.osVersion.platformId})`
            );
        }

        // Apply screen resolution override
        if (config.screenResolution) {
            this.screenResolution = {
                width: config.screenResolution.width ?? this.screenResolution.width,
                height: config.screenResolution.height ?? this.screenResolution.height,
                bpp: config.screenResolution.bpp ?? this.screenResolution.bpp,
                refreshRate: normalizeRefreshRate(
                    config.screenResolution.refreshRate ??
                    config.screenResolution.refresh ??
                    this.screenResolution.refreshRate
                ),
            };
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: Screen resolution set to ${this.screenResolution.width}x${this.screenResolution.height}x${this.screenResolution.bpp}@${this.screenResolution.refreshRate}Hz`
            );
        }

        // Apply supported resolutions for EnumDisplayModes
        if (config.supportedResolutions && config.supportedResolutions.length > 0) {
            this.supportedResolutions = (config.supportedResolutions as DisplayModeInput[]).map(res => ({
                width: res.width,
                height: res.height,
                bpp: res.bpp ?? 16,
                refreshRate: normalizeRefreshRate(res.refreshRate ?? res.refresh),
            }));
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: Supported resolutions: ${this.supportedResolutions.map(r => `${r.width}x${r.height}x${r.bpp}@${r.refreshRate}Hz`).join(", ")}`
            );
        }

        // Apply screen background color override
        if (config.screenBackgroundColor) {
            this.screenBackgroundColor = {
                r: config.screenBackgroundColor.r ?? this.screenBackgroundColor.r,
                g: config.screenBackgroundColor.g ?? this.screenBackgroundColor.g,
                b: config.screenBackgroundColor.b ?? this.screenBackgroundColor.b,
                a: config.screenBackgroundColor.a ?? this.screenBackgroundColor.a,
            };
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: Screen background color set to RGBA(${this.screenBackgroundColor.r}, ${this.screenBackgroundColor.g}, ${this.screenBackgroundColor.b}, ${this.screenBackgroundColor.a})`
            );
        }

        // Apply memory configuration
        if (config.memory) {
            if (config.memory.ram !== undefined) {
                this.memory.ram = this.validateRam(config.memory.ram);
                Logger.log(
                    LogCategory.SYSTEM,
                    `EmulatorConfig: RAM set to ${(this.memory.ram / 1024 / 1024).toFixed(0)} MB`
                );
            }
            if (config.memory.vram !== undefined) {
                this.memory.vram = this.validateVram(config.memory.vram);
                Logger.log(
                    LogCategory.SYSTEM,
                    `EmulatorConfig: VRAM set to ${(this.memory.vram / 1024 / 1024).toFixed(0)} MB`
                );
            }
        }

        // Apply D3D caps override (merge with defaults)
        if (config.d3dCaps) {
            if (config.d3dCaps.dwMaxTextureWidth !== undefined) {
                this.d3dCaps.dwMaxTextureWidth = this.validateTextureSize(config.d3dCaps.dwMaxTextureWidth);
            }
            if (config.d3dCaps.dwMaxTextureHeight !== undefined) {
                this.d3dCaps.dwMaxTextureHeight = this.validateTextureSize(config.d3dCaps.dwMaxTextureHeight);
            }
            if (config.d3dCaps.dwMaxAnisotropy !== undefined) {
                this.d3dCaps.dwMaxAnisotropy = Math.max(1, Math.min(16, config.d3dCaps.dwMaxAnisotropy));
            }
            if (config.d3dCaps.dwMaxTextureRepeat !== undefined) {
                this.d3dCaps.dwMaxTextureRepeat = this.validateTextureSize(config.d3dCaps.dwMaxTextureRepeat);
            }
            if (config.d3dCaps.dwMaxTextureAspectRatio !== undefined) {
                this.d3dCaps.dwMaxTextureAspectRatio = this.validateTextureSize(config.d3dCaps.dwMaxTextureAspectRatio);
            }
            if (config.d3dCaps.dwMaxVertexCount !== undefined) {
                this.d3dCaps.dwMaxVertexCount = Math.max(1, Math.min(65535, config.d3dCaps.dwMaxVertexCount));
            }
            if (config.d3dCaps.wMaxTextureBlendStages !== undefined) {
                this.d3dCaps.wMaxTextureBlendStages = Math.max(1, Math.min(8, config.d3dCaps.wMaxTextureBlendStages));
            }
            if (config.d3dCaps.wMaxSimultaneousTextures !== undefined) {
                this.d3dCaps.wMaxSimultaneousTextures = Math.max(1, Math.min(8, config.d3dCaps.wMaxSimultaneousTextures));
            }
            Logger.log(LogCategory.SYSTEM, "EmulatorConfig: D3D caps updated from manifest");
        }

        // Apply DDraw caps override (merge with defaults)
        if (config.ddrawCaps) {
            if (config.ddrawCaps.dwCaps !== undefined) {
                this.ddrawCaps.dwCaps = config.ddrawCaps.dwCaps;
            }
            if (config.ddrawCaps.dwCaps2 !== undefined) {
                this.ddrawCaps.dwCaps2 = config.ddrawCaps.dwCaps2;
            }
            if (config.ddrawCaps.dwVidMemTotal !== undefined) {
                this.ddrawCaps.dwVidMemTotal = this.validateVram(config.ddrawCaps.dwVidMemTotal);
                // Update memory.vram if it wasn't explicitly set
                if (config.memory?.vram === undefined) {
                    this.memory.vram = this.ddrawCaps.dwVidMemTotal;
                }
            }
            if (config.ddrawCaps.dwVidMemFree !== undefined) {
                this.ddrawCaps.dwVidMemFree = Math.min(
                    config.ddrawCaps.dwVidMemFree,
                    this.ddrawCaps.dwVidMemTotal
                );
            }
            Logger.log(LogCategory.SYSTEM, "EmulatorConfig: DDraw caps updated from manifest");
        }

        // Apply locale/codepage configuration
        if (config.codepage !== undefined) {
            this.ansiCodePage = config.codepage;
            Logger.log(LogCategory.SYSTEM, `EmulatorConfig: ANSI code page set to ${this.ansiCodePage}`);
        }
        if (config.oemCodepage !== undefined) {
            this.oemCodePage = config.oemCodepage;
            Logger.log(LogCategory.SYSTEM, `EmulatorConfig: OEM code page set to ${this.oemCodePage}`);
        }
        if (config.lcid !== undefined) {
            this.lcid = config.lcid;
            Logger.log(LogCategory.SYSTEM, `EmulatorConfig: LCID set to 0x${this.lcid.toString(16).padStart(4, '0')}`);
        }

        // Apply skipVideo flag
        if (config.skipVideo) {
            this.skipVideo = true;
            Logger.log(LogCategory.SYSTEM, "EmulatorConfig: Video playback DISABLED (skipVideo=true)");
        }

        // Apply strict-FPU flag (boot with relaxed-FPU off → full 80-bit x87 precision).
        if (config.fpuStrict) {
            this.fpuStrict = true;
            Logger.log(LogCategory.SYSTEM, "EmulatorConfig: strict x87 FPU (relaxed-FPU disabled at boot, fpuStrict=true)");
        }

        // Apply per-game graphics quality override (layers on top of the global user pref)
        if (config.quality) {
            this.quality = mergeQuality(this.quality, config.quality as Partial<QualityConfig>);
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: quality from manifest (aniso=${this.quality.anisotropy} bright=${this.quality.brightness} aspect=${this.quality.aspectMode})`
            );
        }

        // Apply LoadLibrary deny-list for optional game drivers (OpenGL/Glide/etc)
        if (config.disabledDlls && config.disabledDlls.length > 0) {
            this.disabledDlls = config.disabledDlls
                .map((rule) => typeof rule === "string" ? rule.trim() : "")
                .filter((rule) => rule.length > 0);
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: disabledDlls loaded (${this.disabledDlls.length}): ${this.disabledDlls.join(", ")}`
            );
        }

        // Apply shellExecFake rules
        if (config.shellExecFake && config.shellExecFake.length > 0) {
            this.shellExecFake = config.shellExecFake;
            Logger.log(LogCategory.SYSTEM, `EmulatorConfig: ${this.shellExecFake.length} shellExecFake rule(s) loaded`);
        }

        // Apply deleteOnBoot list
        if (config.deleteOnBoot && config.deleteOnBoot.length > 0) {
            this.deleteOnBoot = config.deleteOnBoot
                .map((p) => typeof p === "string" ? p.trim() : "")
                .filter((p) => p.length > 0);
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: deleteOnBoot loaded (${this.deleteOnBoot.length}): ${this.deleteOnBoot.join(", ")}`
            );
        }

        // Apply writeFiles list (data-driven per-game config overrides)
        if (config.writeFiles && config.writeFiles.length > 0) {
            this.writeFiles = config.writeFiles
                .filter((f) => f && typeof f.path === "string" && f.path.trim().length > 0);
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: writeFiles loaded (${this.writeFiles.length}): ${this.writeFiles.map((f) => f.path).join(", ")}`
            );
        }

        // Apply createDirs list (installer-created empty dirs lost by ZIP packing)
        if (config.createDirs && !Array.isArray(config.createDirs)) {
            Logger.error(LogCategory.SYSTEM,
                `EmulatorConfig: createDirs must be an array of paths, got ${typeof config.createDirs} — ignored`);
        } else if (config.createDirs && config.createDirs.length > 0) {
            this.createDirs = config.createDirs
                .filter((d) => typeof d === "string" && d.trim().length > 0);
            Logger.log(
                LogCategory.SYSTEM,
                `EmulatorConfig: createDirs loaded (${this.createDirs.length}): ${this.createDirs.join(", ")}`
            );
        }
    }

    /**
     * Apply a partial graphics-quality update (from set_quality / dbg.quality / manifest).
     * Validates + clamps + merges onto the current config. Returns the new effective config.
     */
    applyQuality(partial: Partial<QualityConfig> | null | undefined): QualityConfig {
        this.quality = mergeQuality(this.quality, partial);
        return this.quality;
    }

    /**
     * Reset configuration to defaults
     */
    reset(): void {
        this.osVersion = { ...DEFAULT_OS_VERSION };
        this.screenResolution = { ...DEFAULT_SCREEN_RESOLUTION };
        this.supportedResolutions = [...DEFAULT_DISPLAY_MODES];
        this.memory = {
            ram: EMU_MEMORY_SIZE,
            vram: EMU_DDRAW_DEFAULT_CAPS.dwVidMemTotal,
        };
        this.d3dCaps = { ...EMU_D3D_DEFAULT_CAPS };
        this.ddrawCaps = { ...EMU_DDRAW_DEFAULT_CAPS };
        this.screenBackgroundColor = { ...DEFAULT_SCREEN_BACKGROUND };
        this.skipVideo = false;
        this.fpuStrict = false;
        this.disabledDlls = [];
        this.shellExecFake = [];
        this.deleteOnBoot = [];
        this.writeFiles = [];
        this.createDirs = [];
        this.ue1 = false;
        this.ue1UserDir = null;
        // hleLibs intentionally NOT reset — it's a dev/debug toggle that the
        // user flips once (hleEnable) and expects to persist across loadApp.
        // A per-game manifest could still opt-in via applyFromManifest later.
        // quality intentionally NOT reset — global user preference (set via
        // set_quality from host localStorage); manifest.quality layers on at load.
    }

    /**
     * Get GetVersion return value (DWORD)
     * Returns version in format: (platformId << 16) | (build << 8) | (minor << 4) | major
     * For Win9x: high bit set (0x80000000)
     */
    getVersionValue(): number {
        const { major, minor, build, platformId } = this.osVersion;
        if (platformId === VER_PLATFORM_WIN32_WINDOWS) {
            // Win9x format: 0x80000000 | (build << 16) | (minor << 8) | major
            // Note: Bit 31 is set for Win9x. Build is often just high word.
            return 0x80000000 | ((build & 0x7fff) << 16) | ((minor & 0xff) << 8) | (major & 0xff);
        } else {
            // WinNT format: (build << 16) | (minor << 8) | major
            // Bit 31 is clear for NT. Low word is minor/major. High word is build.
            return ((build & 0xffff) << 16) | ((minor & 0xff) << 8) | (major & 0xff);
        }
    }

    // Validation helpers
    private validateRam(ram: number): number {
        // Minimum 64MB, maximum 2GB
        const minRam = 64 * 1024 * 1024;
        const maxRam = 2 * 1024 * 1024 * 1024;
        let validated = Math.max(minRam, Math.min(maxRam, ram));
        if (validated !== ram) {
            Logger.warn(
                LogCategory.SYSTEM,
                `EmulatorConfig: RAM value ${(ram / 1024 / 1024).toFixed(0)} MB clamped to ${(validated / 1024 / 1024).toFixed(0)} MB (min: 64MB, max: 2GB)`
            );
        }
        // v86 identity-maps guest RAM in mem8[0..memory_size). Addresses >= memory_size
        // route to mmap (writes discarded). SURFACE_PIXELS starts at MEM_SURFACE_BASE
        // (704MB) — manifest RAM below that makes every Lock/write→Unlock texture fill silent.
        const layoutMinRam = MEM_SURFACE_BASE + (64 * 1024 * 1024);
        if (validated < layoutMinRam) {
            Logger.warn(
                LogCategory.SYSTEM,
                `EmulatorConfig: RAM ${(validated / 1024 / 1024).toFixed(0)} MB is below SURFACE layout ` +
                `(0x${MEM_SURFACE_BASE.toString(16)}). Guest CPU writes to textures would hit v86 mmap void. ` +
                `Raising to ${(layoutMinRam / 1024 / 1024).toFixed(0)} MB.`
            );
            validated = layoutMinRam;
        }
        return validated;
    }

    private validateVram(vram: number): number {
        // Minimum 16MB, maximum 512MB
        const minVram = 16 * 1024 * 1024;
        const maxVram = 512 * 1024 * 1024;
        const validated = Math.max(minVram, Math.min(maxVram, vram));
        if (validated !== vram) {
            Logger.warn(
                LogCategory.SYSTEM,
                `EmulatorConfig: VRAM value ${(vram / 1024 / 1024).toFixed(0)} MB clamped to ${(validated / 1024 / 1024).toFixed(0)} MB (min: 16MB, max: 512MB)`
            );
        }
        return validated;
    }

    private validateTextureSize(size: number): number {
        // Minimum 1, maximum 4096
        const validated = Math.max(1, Math.min(4096, size));
        if (validated !== size) {
            Logger.warn(
                LogCategory.SYSTEM,
                `EmulatorConfig: Texture size ${size} clamped to ${validated} (min: 1, max: 4096)`
            );
        }
        return validated;
    }
}
