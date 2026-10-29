/**
 * Inno Setup version parsing — ported from innoextract setup/version.hpp + version.cpp.
 */

import { InnoFormatError } from "./errors";

/** setup/version.hpp:41-47 */
export type VersionConstant = number;

export const INNO_VERSION_EXT = (a: number, b: number, c: number, d: number): VersionConstant =>
    ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

export const INNO_VERSION = (a: number, b: number, c: number): VersionConstant =>
    INNO_VERSION_EXT(a, b, c, 0);

/** setup/version.hpp:51-55 — variant flags */
export const VersionFlags = {
    Bits16: 1 << 0,
    Unicode: 1 << 1,
    ISX: 1 << 2,
} as const;

/** Supported range: [5.1.0, 6.4.x]. The 5.1.x field gates are ported from innoextract like the rest. */
export const MIN_SUPPORTED_VERSION = INNO_VERSION(5, 1, 0);
export const MAX_SUPPORTED_VERSION = INNO_VERSION_EXT(6, 4, 255, 255);

/** setup/version.cpp:74-189 — known version table (5.x unicode entries required) */
const KNOWN_VERSIONS: { name: string; version: VersionConstant; variant: number }[] = [
    { name: "Inno Setup Setup Data (5.0.0)", version: INNO_VERSION_EXT(5, 0, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.0.1)", version: INNO_VERSION_EXT(5, 0, 1, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.0.3)", version: INNO_VERSION_EXT(5, 0, 3, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.0.4)", version: INNO_VERSION_EXT(5, 0, 4, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.1.0)", version: INNO_VERSION_EXT(5, 1, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.1.2)", version: INNO_VERSION_EXT(5, 1, 2, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.1.7)", version: INNO_VERSION_EXT(5, 1, 7, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.1.10)", version: INNO_VERSION_EXT(5, 1, 10, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.1.13)", version: INNO_VERSION_EXT(5, 1, 13, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.2.0)", version: INNO_VERSION_EXT(5, 2, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.2.1)", version: INNO_VERSION_EXT(5, 2, 1, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.2.3)", version: INNO_VERSION_EXT(5, 2, 3, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.2.5)", version: INNO_VERSION_EXT(5, 2, 5, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.2.5) (u)", version: INNO_VERSION_EXT(5, 2, 5, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.0)", version: INNO_VERSION_EXT(5, 3, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.0) (u)", version: INNO_VERSION_EXT(5, 3, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.3)", version: INNO_VERSION_EXT(5, 3, 3, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.3) (u)", version: INNO_VERSION_EXT(5, 3, 3, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.5)", version: INNO_VERSION_EXT(5, 3, 5, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.5) (u)", version: INNO_VERSION_EXT(5, 3, 5, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.6)", version: INNO_VERSION_EXT(5, 3, 6, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.6) (u)", version: INNO_VERSION_EXT(5, 3, 6, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.7)", version: INNO_VERSION_EXT(5, 3, 7, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.7) (u)", version: INNO_VERSION_EXT(5, 3, 7, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.8)", version: INNO_VERSION_EXT(5, 3, 8, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.8) (u)", version: INNO_VERSION_EXT(5, 3, 8, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.9)", version: INNO_VERSION_EXT(5, 3, 9, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.9) (u)", version: INNO_VERSION_EXT(5, 3, 9, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.3.10)", version: INNO_VERSION_EXT(5, 3, 10, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.3.10) (u)", version: INNO_VERSION_EXT(5, 3, 10, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.4.2)", version: INNO_VERSION_EXT(5, 4, 2, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.4.2) (u)", version: INNO_VERSION_EXT(5, 4, 2, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.5.0)", version: INNO_VERSION_EXT(5, 5, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.5.0) (u)", version: INNO_VERSION_EXT(5, 5, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.5.6)", version: INNO_VERSION_EXT(5, 5, 6, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.5.6) (u)", version: INNO_VERSION_EXT(5, 5, 6, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.5.7)", version: INNO_VERSION_EXT(5, 5, 7, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.5.7) (u)", version: INNO_VERSION_EXT(5, 5, 7, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.5.7) (U)", version: INNO_VERSION_EXT(5, 5, 7, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.6.0)", version: INNO_VERSION_EXT(5, 6, 0, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.6.0) (u)", version: INNO_VERSION_EXT(5, 6, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (5.6.2)", version: INNO_VERSION_EXT(5, 6, 2, 0), variant: 0 },
    { name: "Inno Setup Setup Data (5.6.2) (u)", version: INNO_VERSION_EXT(5, 6, 2, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (6.0.0) (u)", version: INNO_VERSION_EXT(6, 0, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (6.1.0) (u)", version: INNO_VERSION_EXT(6, 1, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (6.3.0)", version: INNO_VERSION_EXT(6, 3, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (6.4.0)", version: INNO_VERSION_EXT(6, 4, 0, 0), variant: VersionFlags.Unicode },
    { name: "Inno Setup Setup Data (6.4.0.1)", version: INNO_VERSION_EXT(6, 4, 0, 1), variant: VersionFlags.Unicode },
];

export class InnoVersion {
    value: VersionConstant = 0;
    variant = 0;
    known = false;
    readonly rawString: string;

    constructor(value: VersionConstant, variant = 0, known = false, rawString = "") {
        this.value = value;
        this.variant = variant;
        this.known = known;
        this.rawString = rawString;
    }

    a(): number {
        return this.value >>> 24;
    }
    b(): number {
        return (this.value >>> 16) & 0xff;
    }
    c(): number {
        return (this.value >>> 8) & 0xff;
    }
    d(): number {
        return this.value & 0xff;
    }

    /** setup/version.hpp:80 */
    bits(): number {
        return (this.variant & VersionFlags.Bits16) !== 0 ? 16 : 32;
    }

    /** setup/version.hpp:81 */
    isUnicode(): boolean {
        return (this.variant & VersionFlags.Unicode) !== 0;
    }

    isIsx(): boolean {
        return (this.variant & VersionFlags.ISX) !== 0;
    }

    atLeast(a: number, b: number, c: number, d = 0): boolean {
        return this.value >= INNO_VERSION_EXT(a, b, c, d);
    }

    toString(): string {
        let s = `${this.a()}.${this.b()}.${this.c()}`;
        if (this.d()) s += `.${this.d()}`;
        if (this.isUnicode()) s += " (unicode)";
        return s;
    }
}

function parseVersionFromString(versionStr: string): VersionConstant {
    const digits = "0123456789";
    let value = 0;
    let bracket = versionStr.indexOf("(");
    while (bracket !== -1) {
        if (versionStr.length - bracket < 6) {
            bracket = versionStr.indexOf("(", bracket + 1);
            continue;
        }
        try {
            let aStart = bracket + 1;
            let aEnd = aStart;
            while (aEnd < versionStr.length && digits.includes(versionStr[aEnd]!)) aEnd++;
            if (aEnd >= versionStr.length || versionStr[aEnd] !== ".") {
                bracket = versionStr.indexOf("(", bracket + 1);
                continue;
            }
            const a = parseInt(versionStr.slice(aStart, aEnd), 10);

            let bStart = aEnd + 1;
            let bEnd = bStart;
            while (bEnd < versionStr.length && digits.includes(versionStr[bEnd]!)) bEnd++;
            if (bEnd >= versionStr.length || versionStr[bEnd] !== ".") {
                bracket = versionStr.indexOf("(", bracket + 1);
                continue;
            }
            const b = parseInt(versionStr.slice(bStart, bEnd), 10);

            let cStart = bEnd + 1;
            let cEnd = cStart;
            while (cEnd < versionStr.length && digits.includes(versionStr[cEnd]!)) cEnd++;
            if (cEnd >= versionStr.length) {
                bracket = versionStr.indexOf("(", bracket + 1);
                continue;
            }
            const c = parseInt(versionStr.slice(cStart, cEnd), 10);

            let dStart = cEnd;
            if (versionStr[dStart] === "a") dStart++;
            let d = 0;
            if (versionStr[dStart] === ".") {
                dStart++;
                let dEnd = dStart;
                while (dEnd < versionStr.length && digits.includes(versionStr[dEnd]!)) dEnd++;
                if (dEnd > dStart) d = parseInt(versionStr.slice(dStart, dEnd), 10);
            }
            value = Math.max(value, INNO_VERSION_EXT(a, b, c, d));
        } catch {
            // try next bracket
        }
        bracket = versionStr.indexOf("(", bracket + 1);
    }
    return value;
}

/** setup/version.cpp:215-360 */
export function parseVersionString(bytes: Uint8Array, baseOffset = 0): InnoVersion {
    if (bytes.byteLength < 64) {
        throw new InnoFormatError("version string too short", baseOffset);
    }

    const legacy = bytes.subarray(0, 12);
    if (legacy[0] === 0x69 && legacy[11] === 0x1a) {
        throw new InnoFormatError("legacy version format not supported in M2", baseOffset);
    }

    const versionBytes = bytes.subarray(0, 64);
    const nulIdx = versionBytes.indexOf(0);
    const rawString = new TextDecoder("latin1").decode(
        versionBytes.subarray(0, nulIdx >= 0 ? nulIdx : 64),
    );

    for (const kv of KNOWN_VERSIONS) {
        if (kv.name.length === 0) continue;
        const nameBytes = new Uint8Array(64);
        const encoded = new TextEncoder().encode(kv.name);
        nameBytes.set(encoded.subarray(0, 64));
        let match = true;
        for (let i = 0; i < 64; i++) {
            if (versionBytes[i] !== nameBytes[i]) {
                match = false;
                break;
            }
        }
        if (match) {
            return new InnoVersion(kv.version, kv.variant, true, rawString);
        }
    }

    if (!rawString.includes("Inno Setup")) {
        throw new InnoFormatError(`invalid version string: "${rawString}"`, baseOffset);
    }

    const value = parseVersionFromString(rawString);
    if (!value) {
        throw new InnoFormatError(`could not parse version from: "${rawString}"`, baseOffset);
    }

    let variant = 0;
    if (value >= INNO_VERSION(6, 3, 0) || rawString.includes("(u)") || rawString.includes("(U)")) {
        variant |= VersionFlags.Unicode;
    }
    if (rawString.includes("My Inno Setup Extensions") || rawString.includes("with ISX")) {
        variant |= VersionFlags.ISX;
    }

    return new InnoVersion(value, variant, false, rawString);
}

export function assertSupportedVersion(version: InnoVersion, offset?: number): void {
    if (version.value < MIN_SUPPORTED_VERSION || version.value > MAX_SUPPORTED_VERSION) {
        throw new InnoFormatError(
            `unsupported Inno Setup version ${version.toString()} (supported: 5.1.0 – 6.4.x)`,
            offset,
        );
    }
}

export function readVersionAt(data: Uint8Array, baseOffset: number): InnoVersion {
    const slice = data.byteLength === 64 ? data : data.subarray(0, Math.min(64, data.byteLength));
    const version = parseVersionString(slice, baseOffset);
    assertSupportedVersion(version, baseOffset);
    return version;
}

export const CP_UTF16LE = 1200;

export function codepageForVersion(version: InnoVersion, languages: { codepage: number }[]): number {
    if (version.isUnicode()) return CP_UTF16LE;
    if (languages.length === 0) return 1252;
    for (const lang of languages) {
        if (lang.codepage === 1252) return 1252;
    }
    return languages[0]!.codepage;
}
