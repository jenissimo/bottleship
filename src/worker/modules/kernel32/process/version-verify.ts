/**
 * VerSetConditionMask / VerifyVersionInfoW — faithful kernel32 version checks.
 * Semantics per the documented VerifyVersionInfo contract: independent per-field
 * comparisons, except major/minor/servicepack which compare hierarchically
 * ("6.1 >= 5.1" ⇔ major > 5, or major == 5 and minor >= 1). Condition-mask bit
 * layout follows the public winnt.h VER_SET_CONDITION packing (3 bits per field).
 */

import { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { System } from '../../../core/system';
import {
    EmulatorConfig,
    VER_PLATFORM_WIN32_NT,
} from '../../../core/emulator-config-manager';
import { isValidAddress } from '../../../core/memory/address-guard';
import { Mem } from '../../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../../core/logger';
import { getCPU } from '../../../core/thunking/thunk-utils';

const ERROR_BAD_ARGUMENTS = 160;
const ERROR_OLD_WIN_VERSION = 1150;

const OSVERSIONINFOW_SIZE = 276;
const OSVERSIONINFOEXW_SIZE = 284;
// The ANSI struct differs only in szCSDVersion being CHAR[128] instead of WCHAR[128].
const OSVERSIONINFOA_SIZE = 148;
const OSVERSIONINFOEXA_SIZE = 156;

export const VER_MINORVERSION = 0x00000001;
export const VER_MAJORVERSION = 0x00000002;
export const VER_BUILDNUMBER = 0x00000004;
export const VER_PLATFORMID = 0x00000008;
export const VER_SERVICEPACKMINOR = 0x00000010;
export const VER_SERVICEPACKMAJOR = 0x00000020;
export const VER_SUITENAME = 0x00000040;
export const VER_PRODUCT_TYPE = 0x00000080;

export const VER_EQUAL = 1;
export const VER_GREATER = 2;
export const VER_GREATER_EQUAL = 3;
export const VER_LESS = 4;
export const VER_LESS_EQUAL = 5;
export const VER_AND = 6;
export const VER_OR = 7;

export const VER_NT_WORKSTATION = 0x00000001;

export interface OsVersionExFields {
    dwMajorVersion: number;
    dwMinorVersion: number;
    dwBuildNumber: number;
    dwPlatformId: number;
    wServicePackMajor: number;
    wServicePackMinor: number;
    wSuiteMask: number;
    wProductType: number;
}

/** winnt.h condition-mask slot index per type flag (each slot is 3 bits at index*3). */
const CONDITION_SLOT: ReadonlyArray<readonly [typeFlag: number, slot: number]> = [
    [VER_MINORVERSION, 0],
    [VER_MAJORVERSION, 1],
    [VER_BUILDNUMBER, 2],
    [VER_PLATFORMID, 3],
    [VER_SERVICEPACKMINOR, 4],
    [VER_SERVICEPACKMAJOR, 5],
    [VER_SUITENAME, 6],
    [VER_PRODUCT_TYPE, 7],
];

function conditionAt(maskLo: number, maskHi: number, slot: number): number {
    const bit = slot * 3;
    return bit < 32 ? (maskLo >>> bit) & 0x07 : (maskHi >>> (bit - 32)) & 0x07;
}

export function verSetConditionMask(
    maskLo: number,
    maskHi: number,
    typeMask: number,
    condition: number,
): { lo: number; hi: number } {
    const bits = condition & 0x07;
    let lo = maskLo >>> 0;
    let hi = maskHi >>> 0;
    for (const [flag, slot] of CONDITION_SLOT) {
        if (!(typeMask & flag)) continue;
        const bit = slot * 3;
        if (bit < 32) lo = (lo | (bits << bit)) >>> 0;
        else hi = (hi | (bits << (bit - 32))) >>> 0;
    }
    return { lo, hi };
}

/** -1/0/+1 ordering result checked against a VER_* relational condition. */
function orderingSatisfies(cmp: number, condition: number): boolean {
    switch (condition) {
        case VER_EQUAL: return cmp === 0;
        case VER_GREATER: return cmp > 0;
        case VER_GREATER_EQUAL: return cmp >= 0;
        case VER_LESS: return cmp < 0;
        case VER_LESS_EQUAL: return cmp <= 0;
        default: return false;
    }
}

export function getEmulatedOsVersionEx(): OsVersionExFields {
    const { major, minor, build, platformId } = EmulatorConfig.getInstance().osVersion;
    return {
        dwMajorVersion: major,
        dwMinorVersion: minor,
        dwBuildNumber: build,
        dwPlatformId: platformId,
        wServicePackMajor: 0,
        wServicePackMinor: 0,
        wSuiteMask: 0,
        wProductType: platformId === VER_PLATFORM_WIN32_NT ? VER_NT_WORKSTATION : 0,
    };
}

export function readOsVersionCriteriaW(mem: Uint8Array, ptr: number): OsVersionExFields | null {
    if (!ptr || !isValidAddress(ptr, OSVERSIONINFOW_SIZE, 'rw')) {
        return null;
    }
    const dwSize = Mem.readUint32(ptr);
    if (dwSize === null || dwSize < OSVERSIONINFOW_SIZE) {
        return null;
    }

    const criteria: OsVersionExFields = {
        dwMajorVersion: Mem.readUint32(ptr + 4) ?? 0,
        dwMinorVersion: Mem.readUint32(ptr + 8) ?? 0,
        dwBuildNumber: Mem.readUint32(ptr + 12) ?? 0,
        dwPlatformId: Mem.readUint32(ptr + 16) ?? 0,
        wServicePackMajor: 0,
        wServicePackMinor: 0,
        wSuiteMask: 0,
        wProductType: 0,
    };

    if (dwSize >= OSVERSIONINFOEXW_SIZE) {
        criteria.wServicePackMajor = Mem.readUint16(ptr + 276) ?? 0;
        criteria.wServicePackMinor = Mem.readUint16(ptr + 278) ?? 0;
        criteria.wSuiteMask = Mem.readUint16(ptr + 280) ?? 0;
        criteria.wProductType = Mem.readUint8(ptr + 282) ?? 0;
    }

    return criteria;
}

export function readOsVersionCriteriaA(mem: Uint8Array, ptr: number): OsVersionExFields | null {
    if (!ptr || !isValidAddress(ptr, OSVERSIONINFOA_SIZE, 'rw')) {
        return null;
    }
    const dwSize = Mem.readUint32(ptr);
    if (dwSize === null || dwSize < OSVERSIONINFOA_SIZE) {
        return null;
    }

    const criteria: OsVersionExFields = {
        dwMajorVersion: Mem.readUint32(ptr + 4) ?? 0,
        dwMinorVersion: Mem.readUint32(ptr + 8) ?? 0,
        dwBuildNumber: Mem.readUint32(ptr + 12) ?? 0,
        dwPlatformId: Mem.readUint32(ptr + 16) ?? 0,
        wServicePackMajor: 0,
        wServicePackMinor: 0,
        wSuiteMask: 0,
        wProductType: 0,
    };

    if (dwSize >= OSVERSIONINFOEXA_SIZE) {
        criteria.wServicePackMajor = Mem.readUint16(ptr + 148) ?? 0;
        criteria.wServicePackMinor = Mem.readUint16(ptr + 150) ?? 0;
        criteria.wSuiteMask = Mem.readUint16(ptr + 152) ?? 0;
        criteria.wProductType = Mem.readUint8(ptr + 154) ?? 0;
    }

    return criteria;
}

/**
 * The version fields compared as ONE hierarchical value, most significant first
 * (documented VerifyVersionInfo behavior). Only fields flagged in typeMask
 * participate; the whole tuple is checked against the condition of the most
 * significant flagged field (mixing operators across these fields is
 * undocumented, and callers built via VER_SET_CONDITION use one operator).
 */
const HIERARCHICAL_FIELDS: ReadonlyArray<readonly [typeFlag: number, slot: number, key: keyof OsVersionExFields]> = [
    [VER_MAJORVERSION, 1, 'dwMajorVersion'],
    [VER_MINORVERSION, 0, 'dwMinorVersion'],
    [VER_SERVICEPACKMAJOR, 5, 'wServicePackMajor'],
    [VER_SERVICEPACKMINOR, 4, 'wServicePackMinor'],
];

export function verifyVersionInfoEx(
    criteria: OsVersionExFields,
    typeMask: number,
    maskLo: number,
    maskHi: number,
    actual: OsVersionExFields,
): boolean {
    const dwTypeMask = typeMask >>> 0;
    if (!dwTypeMask || (maskLo === 0 && maskHi === 0)) {
        return false;
    }

    if (dwTypeMask & VER_PRODUCT_TYPE) {
        const cmp = actual.wProductType - criteria.wProductType;
        if (!orderingSatisfies(Math.sign(cmp), conditionAt(maskLo, maskHi, 7))) return false;
    }

    if (dwTypeMask & VER_SUITENAME) {
        switch (conditionAt(maskLo, maskHi, 6)) {
            case VER_AND: // every requested suite bit present
                if ((criteria.wSuiteMask & actual.wSuiteMask) !== criteria.wSuiteMask) return false;
                break;
            case VER_OR: // at least one requested suite bit present
                if (criteria.wSuiteMask && !(criteria.wSuiteMask & actual.wSuiteMask)) return false;
                break;
            default:
                return false;
        }
    }

    if (dwTypeMask & VER_PLATFORMID) {
        const cmp = actual.dwPlatformId - criteria.dwPlatformId;
        if (!orderingSatisfies(Math.sign(cmp), conditionAt(maskLo, maskHi, 3))) return false;
    }

    if (dwTypeMask & VER_BUILDNUMBER) {
        const cmp = actual.dwBuildNumber - criteria.dwBuildNumber;
        if (!orderingSatisfies(Math.sign(cmp), conditionAt(maskLo, maskHi, 2))) return false;
    }

    const flagged = HIERARCHICAL_FIELDS.filter(([flag]) => dwTypeMask & flag);
    if (flagged.length > 0) {
        let cmp = 0;
        for (const [, , key] of flagged) {
            if (actual[key] !== criteria[key]) {
                cmp = actual[key] < criteria[key] ? -1 : 1;
                break;
            }
        }
        if (!orderingSatisfies(cmp, conditionAt(maskLo, maskHi, flagged[0][1]))) return false;
    }

    return true;
}

function setU64Return(lo: number, hi: number): number {
    const cpu = getCPU(System.getInstance().process?.v86);
    if (cpu?.reg32) {
        cpu.reg32[2] = hi >>> 0;
    }
    return lo >>> 0;
}

/**
 * VerifyVersionInfo's A and W forms differ only in how the criteria struct is laid out
 * (szCSDVersion CHAR[128] vs WCHAR[128]); the comparison is identical, so both spellings
 * share one body and cannot answer differently for the same question.
 */
function makeVerifyVersionInfo(
    readCriteria: (mem: Uint8Array, ptr: number) => OsVersionExFields | null,
    apiName: string,
): ThunkImplementation {
    return (_ctx, mem, args) => {
        const infoPtr = args[0] >>> 0;
        const typeMask = args[1] >>> 0;
        const maskLo = args[2] >>> 0;
        const maskHi = args[3] >>> 0;
        const sched = System.getInstance().scheduler;

        const criteria = readCriteria(mem, infoPtr);
        if (!criteria) {
            sched.setLastError(ERROR_BAD_ARGUMENTS);
            return 0;
        }

        if (!typeMask || (maskLo === 0 && maskHi === 0)) {
            sched.setLastError(ERROR_BAD_ARGUMENTS);
            return 0;
        }

        const actual = getEmulatedOsVersionEx();
        if (!verifyVersionInfoEx(criteria, typeMask, maskLo, maskHi, actual)) {
            sched.setLastError(ERROR_OLD_WIN_VERSION);
            Logger.verbose(
                LogCategory.KERNEL32,
                `${apiName}: mismatch (want ${criteria.dwMajorVersion}.${criteria.dwMinorVersion} ` +
                `build ${criteria.dwBuildNumber} platform ${criteria.dwPlatformId}, ` +
                `actual ${actual.dwMajorVersion}.${actual.dwMinorVersion} ` +
                `build ${actual.dwBuildNumber} platform ${actual.dwPlatformId}, ` +
                `typeMask=0x${typeMask.toString(16)} mask=0x${maskHi.toString(16)}${maskLo.toString(16).padStart(8, '0')})`,
            );
            return 0;
        }

        sched.setLastError(0);
        Logger.verbose(
            LogCategory.KERNEL32,
            `${apiName}: match ${actual.dwMajorVersion}.${actual.dwMinorVersion} ` +
            `(typeMask=0x${typeMask.toString(16)})`,
        );
        return 1;
    };
}

export const versionVerifyExports: Record<string, ThunkImplementation> = {
    'VerSetConditionMask': (_ctx, _mem, args) => {
        const maskLo = args[0] >>> 0;
        const maskHi = args[1] >>> 0;
        const typeMask = args[2] >>> 0;
        const condition = args[3] >>> 0;
        const result = verSetConditionMask(maskLo, maskHi, typeMask, condition);
        return setU64Return(result.lo, result.hi);
    },

    'VerifyVersionInfoW': makeVerifyVersionInfo(readOsVersionCriteriaW, 'VerifyVersionInfoW'),

    'VerifyVersionInfoA': makeVerifyVersionInfo(readOsVersionCriteriaA, 'VerifyVersionInfoA'),
};
