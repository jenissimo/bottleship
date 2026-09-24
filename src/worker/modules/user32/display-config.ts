/**
 * CCD display configuration (Win7+): GetDisplayConfigBufferSizes, QueryDisplayConfig,
 * DisplayConfigGetDeviceInfo.
 *
 * The topology is the one the rest of user32 describes: a single adapter driving a single
 * monitor — source 0 (\\.\DISPLAY1, the EnumDisplayDevices/GetMonitorInfo name) on
 * target 0 — in the current EnumDisplaySettings mode. That is also the only path that
 * could exist, so QDC_ALL_PATHS and QDC_ONLY_ACTIVE_PATHS describe the same one path.
 * The adapter LUID is the one IDirect3D9Ex::GetAdapterLUID reports, so an app that
 * matches its D3D adapter against the display config finds it.
 *
 * Structures are built in a host buffer and published with one Mem.writeBytes, after
 * the whole guest extent has been validated.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import { getCurrentScreenMode, getDisplayModes, type DisplayMode } from './system';

const ERROR_SUCCESS = 0;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

const QDC_ALL_PATHS = 0x1;
const QDC_ONLY_ACTIVE_PATHS = 0x2;
const QDC_DATABASE_CURRENT = 0x4;
const QDC_VIRTUAL_MODE_AWARE = 0x10;
const QDC_RETRIEVE_MASK = QDC_ALL_PATHS | QDC_ONLY_ACTIVE_PATHS | QDC_DATABASE_CURRENT;

export const DISPLAYCONFIG_PATH_INFO_SIZE = 72;
export const DISPLAYCONFIG_MODE_INFO_SIZE = 64;
export const DISPLAYCONFIG_DEVICE_INFO_HEADER_SIZE = 20;

/** DISPLAYCONFIG_PATH_INFO: sourceInfo (20) + targetInfo (48) + flags. */
export const PATH_OFFSETS = {
    sourceAdapterId: 0, sourceId: 8, sourceModeInfoIdx: 12, sourceStatusFlags: 16,
    targetAdapterId: 20, targetId: 28, targetModeInfoIdx: 32, outputTechnology: 36,
    rotation: 40, scaling: 44, refreshNumerator: 48, refreshDenominator: 52,
    scanLineOrdering: 56, targetAvailable: 60, targetStatusFlags: 64, flags: 68,
} as const;

/** DISPLAYCONFIG_MODE_INFO: header, then the 48-byte union at +16. */
export const MODE_OFFSETS = {
    infoType: 0, id: 4, adapterId: 8, union: 16,
} as const;

/** DISPLAYCONFIG_VIDEO_SIGNAL_INFO, relative to its start. */
export const SIGNAL_OFFSETS = {
    pixelRate: 0, hSyncNumerator: 8, hSyncDenominator: 12, vSyncNumerator: 16, vSyncDenominator: 20,
    activeCx: 24, activeCy: 28, totalCx: 32, totalCy: 36, videoStandard: 40, scanLineOrdering: 44,
} as const;

const MODE_INFO_TYPE_SOURCE = 1;
const MODE_INFO_TYPE_TARGET = 2;
const MODE_INFO_TYPE_DESKTOP_IMAGE = 3;
const PATH_ACTIVE = 0x1;
const PATH_SUPPORT_VIRTUAL_MODE = 0x8;
const SOURCE_IN_USE = 0x1;
const TARGET_IN_USE = 0x1;
const OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL = 10;
const ROTATION_IDENTITY = 1;
const SCALING_IDENTITY = 1;
const SCANLINE_ORDERING_PROGRESSIVE = 1;
const TOPOLOGY_INTERNAL = 0x1;
const PATH_CLONE_GROUP_INVALID = 0xffff;
const D3DKMDT_VSS_OTHER = 255;

const DEVICE_INFO_GET_SOURCE_NAME = 1;
const DEVICE_INFO_GET_TARGET_NAME = 2;
const DEVICE_INFO_GET_TARGET_PREFERRED_MODE = 3;
const DEVICE_INFO_GET_ADAPTER_NAME = 4;
const DEVICE_INFO_SET_TARGET_PERSISTENCE = 5;
const DEVICE_INFO_GET_TARGET_BASE_TYPE = 6;
const DEVICE_INFO_SET_SUPPORT_VIRTUAL_RESOLUTION = 8;
const DEVICE_INFO_GET_ADVANCED_COLOR_INFO = 9;
const DEVICE_INFO_SET_ADVANCED_COLOR_STATE = 10;
const DEVICE_INFO_GET_SDR_WHITE_LEVEL = 11;

/** sizeof() of each DisplayConfigGetDeviceInfo request packet. */
export const DEVICE_INFO_SIZES: Readonly<Record<number, number>> = {
    [DEVICE_INFO_GET_SOURCE_NAME]: 84,
    [DEVICE_INFO_GET_TARGET_NAME]: 420,
    [DEVICE_INFO_GET_TARGET_PREFERRED_MODE]: 80,
    [DEVICE_INFO_GET_ADAPTER_NAME]: 276,
    [DEVICE_INFO_GET_TARGET_BASE_TYPE]: 24,
    [DEVICE_INFO_GET_ADVANCED_COLOR_INFO]: 32,
    [DEVICE_INFO_GET_SDR_WHITE_LEVEL]: 24,
};

/** Matches IDirect3D9Ex_GetAdapterLUID (d3d9/ex.ts): { LowPart 0, HighPart 1 }. */
const ADAPTER_LUID_LOW = 0;
const ADAPTER_LUID_HIGH = 1;
const SOURCE_ID = 0;
const TARGET_ID = 0;

const SOURCE_GDI_NAME = '\\\\.\\DISPLAY1';
const ADAPTER_DEVICE_PATH =
    '\\\\?\\PCI#VEN_1414&DEV_008C&SUBSYS_00000000&REV_00#3&0&0&0#{5b45201d-f2f2-4f3b-85bb-30ff1f953599}';
/** No EDID: Windows names the monitor Default_Monitor and leaves the friendly name empty. */
const MONITOR_DEVICE_PATH =
    '\\\\?\\DISPLAY#Default_Monitor#4&0&0&UID0#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}';
/** SDRWhiteLevel is in units of 80 nits / 1000: 1000 is the 80-nit default. */
const SDR_WHITE_LEVEL = 1000;

const pixelFormatFor = (bpp: number): number =>
    bpp === 8 || bpp === 16 || bpp === 24 || bpp === 32 ? bpp / 8 : 5; // 5 = NONGDI

class StructWriter {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    constructor(size: number) {
        this.bytes = new Uint8Array(size);
        this.view = new DataView(this.bytes.buffer);
    }
    u32(off: number, v: number): void { this.view.setUint32(off, v >>> 0, true); }
    i32(off: number, v: number): void { this.view.setInt32(off, v | 0, true); }
    u16(off: number, v: number): void { this.view.setUint16(off, v & 0xffff, true); }
    u64(off: number, v: number): void {
        this.view.setUint32(off, v % 0x100000000, true);
        this.view.setUint32(off + 4, Math.floor(v / 0x100000000), true);
    }
    luid(off: number): void { this.u32(off, ADAPTER_LUID_LOW); this.i32(off + 4, ADAPTER_LUID_HIGH); }
    wstr(off: number, s: string, maxChars: number): void {
        const n = Math.min(s.length, maxChars - 1);
        for (let i = 0; i < n; i++) this.u16(off + i * 2, s.charCodeAt(i));
    }
}

function writeSignalInfo(w: StructWriter, off: number, mode: DisplayMode, totalFromMode: boolean): void {
    const hz = mode.refreshRate;
    w.u64(off + SIGNAL_OFFSETS.pixelRate, hz * mode.width * mode.height);
    w.u32(off + SIGNAL_OFFSETS.hSyncNumerator, hz * mode.width);
    w.u32(off + SIGNAL_OFFSETS.hSyncDenominator, 1);
    w.u32(off + SIGNAL_OFFSETS.vSyncNumerator, hz);
    w.u32(off + SIGNAL_OFFSETS.vSyncDenominator, 1);
    w.u32(off + SIGNAL_OFFSETS.activeCx, mode.width);
    w.u32(off + SIGNAL_OFFSETS.activeCy, mode.height);
    w.u32(off + SIGNAL_OFFSETS.totalCx, totalFromMode ? mode.width : 0);
    w.u32(off + SIGNAL_OFFSETS.totalCy, totalFromMode ? mode.height : 0);
    // AdditionalSignalInfo: videoStandard in bits 0-15, vSyncFreqDivider (1) in bits 16-21.
    w.u32(off + SIGNAL_OFFSETS.videoStandard, D3DKMDT_VSS_OTHER | (1 << 16));
    w.u32(off + SIGNAL_OFFSETS.scanLineOrdering, SCANLINE_ORDERING_PROGRESSIVE);
}

const validFlags = (flags: number): boolean => {
    const retrieve = flags & QDC_RETRIEVE_MASK;
    if (retrieve !== QDC_ALL_PATHS && retrieve !== QDC_ONLY_ACTIVE_PATHS && retrieve !== QDC_DATABASE_CURRENT) return false;
    return (flags & ~(QDC_RETRIEVE_MASK | QDC_VIRTUAL_MODE_AWARE)) === 0;
};

const modeCountFor = (flags: number): number => ((flags & QDC_VIRTUAL_MODE_AWARE) ? 3 : 2);

const writable = (mem: Uint8Array, ptr: number, size: number): boolean =>
    ptr !== 0 && ptr + size <= mem.length && isValidAddress(mem, ptr, size, 'rw');

export function createDisplayConfigExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // LONG GetDisplayConfigBufferSizes(UINT32 flags, UINT32 *numPathArrayElements, UINT32 *numModeInfoArrayElements)
    exports['GetDisplayConfigBufferSizes'] = (_ctx, mem, args) => {
        const flags = args[0] >>> 0;
        const pNumPaths = args[1] >>> 0;
        const pNumModes = args[2] >>> 0;
        if (!writable(mem, pNumPaths, 4) || !writable(mem, pNumModes, 4)) return ERROR_INVALID_PARAMETER;
        if (!validFlags(flags)) return ERROR_INVALID_PARAMETER;
        Mem.writeUint32(pNumPaths, 1);
        Mem.writeUint32(pNumModes, modeCountFor(flags));
        return ERROR_SUCCESS;
    };

    // LONG QueryDisplayConfig(UINT32 flags, UINT32 *numPathArrayElements, DISPLAYCONFIG_PATH_INFO *pathArray,
    //                         UINT32 *numModeInfoArrayElements, DISPLAYCONFIG_MODE_INFO *modeInfoArray,
    //                         DISPLAYCONFIG_TOPOLOGY_ID *currentTopologyId)
    exports['QueryDisplayConfig'] = (_ctx, mem, args) => {
        const flags = args[0] >>> 0;
        const pNumPaths = args[1] >>> 0;
        const pathArray = args[2] >>> 0;
        const pNumModes = args[3] >>> 0;
        const modeArray = args[4] >>> 0;
        const pTopology = args[5] >>> 0;
        if (!writable(mem, pNumPaths, 4) || !writable(mem, pNumModes, 4)) return ERROR_INVALID_PARAMETER;
        const numPaths = Mem.readUint32(pNumPaths) ?? 0;
        const numModes = Mem.readUint32(pNumModes) ?? 0;
        if (!numPaths || !numModes || !pathArray || !modeArray) return ERROR_INVALID_PARAMETER;
        if (!validFlags(flags)) return ERROR_INVALID_PARAMETER;
        const database = (flags & QDC_RETRIEVE_MASK) === QDC_DATABASE_CURRENT;
        if (database !== (pTopology !== 0)) return ERROR_INVALID_PARAMETER;
        if (database && !writable(mem, pTopology, 4)) return ERROR_INVALID_PARAMETER;

        const virtualAware = (flags & QDC_VIRTUAL_MODE_AWARE) !== 0;
        const modesNeeded = modeCountFor(flags);
        if (numModes < modesNeeded) return ERROR_INSUFFICIENT_BUFFER;
        if (!writable(mem, pathArray, DISPLAYCONFIG_PATH_INFO_SIZE)
            || !writable(mem, modeArray, modesNeeded * DISPLAYCONFIG_MODE_INFO_SIZE)) {
            return ERROR_INVALID_PARAMETER;
        }

        const mode = getCurrentScreenMode();
        const SOURCE_MODE = 0, TARGET_MODE = 1, DESKTOP_MODE = 2;

        const modes = new StructWriter(modesNeeded * DISPLAYCONFIG_MODE_INFO_SIZE);
        let m = SOURCE_MODE * DISPLAYCONFIG_MODE_INFO_SIZE;
        modes.u32(m + MODE_OFFSETS.infoType, MODE_INFO_TYPE_SOURCE);
        modes.u32(m + MODE_OFFSETS.id, SOURCE_ID);
        modes.luid(m + MODE_OFFSETS.adapterId);
        modes.u32(m + MODE_OFFSETS.union + 0, mode.width);
        modes.u32(m + MODE_OFFSETS.union + 4, mode.height);
        modes.u32(m + MODE_OFFSETS.union + 8, pixelFormatFor(mode.bpp));
        modes.i32(m + MODE_OFFSETS.union + 12, 0); // position.x
        modes.i32(m + MODE_OFFSETS.union + 16, 0); // position.y

        m = TARGET_MODE * DISPLAYCONFIG_MODE_INFO_SIZE;
        modes.u32(m + MODE_OFFSETS.infoType, MODE_INFO_TYPE_TARGET);
        modes.u32(m + MODE_OFFSETS.id, TARGET_ID);
        modes.luid(m + MODE_OFFSETS.adapterId);
        writeSignalInfo(modes, m + MODE_OFFSETS.union, mode, !database);

        if (virtualAware) {
            m = DESKTOP_MODE * DISPLAYCONFIG_MODE_INFO_SIZE;
            modes.u32(m + MODE_OFFSETS.infoType, MODE_INFO_TYPE_DESKTOP_IMAGE);
            modes.u32(m + MODE_OFFSETS.id, TARGET_ID);
            modes.luid(m + MODE_OFFSETS.adapterId);
            const d = m + MODE_OFFSETS.union;
            modes.i32(d + 0, mode.width);   // PathSourceSize
            modes.i32(d + 4, mode.height);
            for (const rect of [d + 8, d + 24]) { // DesktopImageRegion, DesktopImageClip
                modes.i32(rect + 8, mode.width);
                modes.i32(rect + 12, mode.height);
            }
        }

        const path = new StructWriter(DISPLAYCONFIG_PATH_INFO_SIZE);
        path.luid(PATH_OFFSETS.sourceAdapterId);
        path.u32(PATH_OFFSETS.sourceId, SOURCE_ID);
        // Virtual-mode-aware callers read the union as { cloneGroupId:16, sourceModeInfoIdx:16 }.
        path.u32(PATH_OFFSETS.sourceModeInfoIdx, virtualAware
            ? (PATH_CLONE_GROUP_INVALID | (SOURCE_MODE << 16)) >>> 0
            : SOURCE_MODE);
        path.u32(PATH_OFFSETS.sourceStatusFlags, SOURCE_IN_USE);
        path.luid(PATH_OFFSETS.targetAdapterId);
        path.u32(PATH_OFFSETS.targetId, TARGET_ID);
        // ... and the target union as { desktopModeInfoIdx:16, targetModeInfoIdx:16 }.
        path.u32(PATH_OFFSETS.targetModeInfoIdx, virtualAware
            ? (DESKTOP_MODE | (TARGET_MODE << 16)) >>> 0
            : TARGET_MODE);
        path.u32(PATH_OFFSETS.outputTechnology, OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL);
        path.u32(PATH_OFFSETS.rotation, ROTATION_IDENTITY);
        path.u32(PATH_OFFSETS.scaling, SCALING_IDENTITY);
        path.u32(PATH_OFFSETS.refreshNumerator, mode.refreshRate);
        path.u32(PATH_OFFSETS.refreshDenominator, 1);
        path.u32(PATH_OFFSETS.scanLineOrdering, SCANLINE_ORDERING_PROGRESSIVE);
        path.u32(PATH_OFFSETS.targetAvailable, 1);
        path.u32(PATH_OFFSETS.targetStatusFlags, TARGET_IN_USE);
        path.u32(PATH_OFFSETS.flags, PATH_ACTIVE | (virtualAware ? PATH_SUPPORT_VIRTUAL_MODE : 0));

        Mem.writeBytes(pathArray, path.bytes);
        Mem.writeBytes(modeArray, modes.bytes);
        Mem.writeUint32(pNumPaths, 1);
        Mem.writeUint32(pNumModes, modesNeeded);
        if (database) Mem.writeUint32(pTopology, TOPOLOGY_INTERNAL);
        return ERROR_SUCCESS;
    };

    // LONG DisplayConfigGetDeviceInfo(DISPLAYCONFIG_DEVICE_INFO_HEADER *requestPacket)
    exports['DisplayConfigGetDeviceInfo'] = (_ctx, mem, args) => {
        const packet = args[0] >>> 0;
        if (!packet || !isValidAddress(mem, packet, DISPLAYCONFIG_DEVICE_INFO_HEADER_SIZE, 'r')) {
            return ERROR_INVALID_PARAMETER;
        }
        const type = Mem.readUint32(packet) ?? 0;
        const size = Mem.readUint32(packet + 4) ?? 0;
        const adapterLow = Mem.readUint32(packet + 8) ?? 0;
        const adapterHigh = Mem.readInt32(packet + 12) ?? 0;
        const id = Mem.readUint32(packet + 16) ?? 0;

        if (type === DEVICE_INFO_SET_TARGET_PERSISTENCE || type === DEVICE_INFO_SET_SUPPORT_VIRTUAL_RESOLUTION
            || type === DEVICE_INFO_SET_ADVANCED_COLOR_STATE) {
            return ERROR_INVALID_PARAMETER;
        }
        const expected = DEVICE_INFO_SIZES[type];
        if (expected === undefined) return ERROR_NOT_SUPPORTED;
        if (size < expected) return ERROR_INVALID_PARAMETER;
        if (!writable(mem, packet, expected)) return ERROR_INVALID_PARAMETER;
        if (adapterLow !== ADAPTER_LUID_LOW || adapterHigh !== ADAPTER_LUID_HIGH) return ERROR_INVALID_PARAMETER;
        if (type !== DEVICE_INFO_GET_ADAPTER_NAME) {
            const wantId = type === DEVICE_INFO_GET_SOURCE_NAME ? SOURCE_ID : TARGET_ID;
            if (id !== wantId) return ERROR_INVALID_PARAMETER;
        }

        // Only the payload after the caller's header is written.
        const out = new StructWriter(expected);
        const H = DISPLAYCONFIG_DEVICE_INFO_HEADER_SIZE;
        switch (type) {
            case DEVICE_INFO_GET_SOURCE_NAME:
                out.wstr(H, SOURCE_GDI_NAME, 32);
                break;
            case DEVICE_INFO_GET_TARGET_NAME:
                out.u32(H + 0, 0); // flags: no EDID ids, no EDID friendly name
                out.u32(H + 4, OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL);
                out.u32(H + 12, 0); // connectorInstance
                out.wstr(H + 144, MONITOR_DEVICE_PATH, 128);
                break;
            case DEVICE_INFO_GET_TARGET_PREFERRED_MODE: {
                const preferred = preferredMode();
                out.u32(H + 0, preferred.width);
                out.u32(H + 4, preferred.height);
                writeSignalInfo(out, H + 12, preferred, true);
                break;
            }
            case DEVICE_INFO_GET_ADAPTER_NAME:
                out.wstr(H, ADAPTER_DEVICE_PATH, 128);
                break;
            case DEVICE_INFO_GET_TARGET_BASE_TYPE:
                out.u32(H, OUTPUT_TECHNOLOGY_DISPLAYPORT_EXTERNAL);
                break;
            case DEVICE_INFO_GET_ADVANCED_COLOR_INFO:
                out.u32(H + 0, 0); // not supported, not enabled
                out.u32(H + 4, 0); // DISPLAYCONFIG_COLOR_ENCODING_RGB
                out.u32(H + 8, 8); // bitsPerColorChannel
                break;
            case DEVICE_INFO_GET_SDR_WHITE_LEVEL:
                out.u32(H, SDR_WHITE_LEVEL);
                break;
        }
        Mem.writeBytes(packet + H, out.bytes.subarray(H));
        return ERROR_SUCCESS;
    };

    return exports;
}

/** The monitor's native mode: the largest EnumDisplaySettings mode, fastest refresh. */
function preferredMode(): DisplayMode {
    let best: DisplayMode | null = null;
    for (const m of getDisplayModes()) {
        if (!best || m.width * m.height > best.width * best.height
            || (m.width === best.width && m.height === best.height && m.refreshRate > best.refreshRate)) {
            best = m;
        }
    }
    return best ?? getCurrentScreenMode();
}

