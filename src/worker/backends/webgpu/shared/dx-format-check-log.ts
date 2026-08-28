/**
 * Capped CheckDeviceFormat logging — boot-time caps probes (e.g. RenderWare / GTA III
 * CAPS.DAT) without a per-call firehose.
 *
 * The capability fast paths answer memo HITS without reaching here, so a repeated identical
 * query logs once per distinct key by design; the call count lives in getDxFormatSupportCensus.
 */

import { Logger, LogCategory } from "../../../core/logger";
import { D3D_OK } from "./dx-format-support";

const D3DFMT_NAMES: Record<number, string> = {
    0: "UNKNOWN",
    20: "R8G8B8",
    21: "A8R8G8B8",
    22: "X8R8G8B8",
    23: "R5G6B5",
    24: "X1R5G5B5",
    25: "A1R5G5B5",
    26: "A4R4G4B4",
    28: "A8",
    30: "X4R4G4B4",
    40: "A8P8",
    41: "P8",
    50: "L8",
    51: "A8L8",
    52: "A4L4",
};

const RTYPE_NAMES: Record<number, string> = {
    1: "SURFACE",
    3: "TEXTURE",
    4: "VOLUME",
    5: "CUBE",
    6: "VB",
    7: "IB",
};

function fmtName(format: number): string {
    const f = format >>> 0;
    return D3DFMT_NAMES[f] ?? `0x${f.toString(16)}`;
}

function rTypeName(rType: number): string {
    return RTYPE_NAMES[rType] ?? String(rType);
}

const NORMAL_LOG_CAP = 48;
let totalCalls = 0;
const seenOkKeys = new Set<string>();

/** Opt-in unlimited logging from dbg: `d3d8LogCheckFormat(true)` */
let verboseEnabled = false;

export function setDxCheckFormatVerboseLogging(enabled: boolean): void {
    verboseEnabled = enabled;
    if (enabled) {
        Logger.log(LogCategory.D3D9, "CheckDeviceFormat verbose logging enabled");
    }
}

export function resetDxCheckFormatLogForTests(): void {
    totalCalls = 0;
    seenOkKeys.clear();
    verboseEnabled = false;
}

export function logDxCheckDeviceFormat(
    api: "D3D8" | "D3D9",
    adapterFormat: number,
    usage: number,
    rType: number,
    checkFormat: number,
    hr: number,
): void {
    totalCalls++;
    const ok = hr === D3D_OK;
    const key = `${adapterFormat >>> 0}:${usage >>> 0}:${rType}:${checkFormat >>> 0}`;
    const shouldLog =
        verboseEnabled ||
        !ok ||
        totalCalls <= NORMAL_LOG_CAP ||
        !seenOkKeys.has(key);

    if (!shouldLog) return;
    if (ok) seenOkKeys.add(key);

    const result = ok ? "OK" : "NOTAVAILABLE";
    Logger.log(
        LogCategory.D3D9,
        `CheckDeviceFormat(${api}): adapter=${fmtName(adapterFormat)} usage=0x${(usage >>> 0).toString(16)} ` +
            `rType=${rTypeName(rType)} check=${fmtName(checkFormat)} -> ${result}`,
    );
}
