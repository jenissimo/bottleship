/**
 * COMCTL32.dll stub module.
 * Common Controls and ImageList helpers used by legacy apps.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Marshaler } from "../core/memory/marshaler";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { ensureAnimateControlClasses } from "./user32/animate-control";
import { registerFlatSbExports, resetFlatSbState } from "./comctl32-flatsb";
import {
    INITCOMMONCONTROLSEX_SIZE,
    initCommonControls,
    initCommonControlsEx,
} from "./comctl32-init";
import { propertySheet, propSheetDlgProc, resetPropSheetState } from "./comctl32-propsheet";

type ImageListState = {
    count: number;
    bkColor: number;
    cx: number;
    cy: number;
    flags: number;
    cGrow: number;
    cInitial: number;
};

const ILHEAD_SIZE = 28;

function readGuestVtblSlot(mem: Uint8Array, objPtr: number, slot: number): number {
    const vtable = Mem.readUint32(objPtr) ?? 0;
    if (!vtable) return 0;
    return Mem.readUint32(vtable + slot * 4) ?? 0;
}

/** Win32 ImageList_Write stream blob (ILHEAD + color DIB, no mask). */
function buildImageListStreamBlob(list: ImageListState): Uint8Array {
    const cx = list.cx || 1;
    const cy = list.cy || 1;
    const count = list.count;
    const bmWidth = count * cx;
    const bmHeight = cy;
    const bitCount = 32;
    const stride = bmWidth > 0 ? ((bmWidth * bitCount + 31) >> 5) << 2 : 0;
    const sizeImage = stride * bmHeight;
    const dibSize = 14 + 40 + sizeImage;
    const buf = new Uint8Array(ILHEAD_SIZE + dibSize);
    const view = new DataView(buf.buffer);

    view.setUint16(0, 0x4c49, true); // 'IL'
    view.setUint16(2, 0x0101, true);
    view.setUint16(4, count, true);
    view.setUint16(6, Math.max(count, list.cInitial || 4), true);
    view.setUint16(8, list.cGrow || 4, true);
    view.setUint16(10, cx, true);
    view.setUint16(12, cy, true);
    view.setUint32(14, list.bkColor, true);
    view.setUint16(18, list.flags & 0xffff, true);

    let off = ILHEAD_SIZE;
    view.setUint16(off, 0x4d42, true); // 'BM'
    view.setUint32(off + 2, 14 + 40, true);
    view.setUint32(off + 10, 14 + 40, true);
    off += 14;
    view.setUint32(off, 40, true);
    view.setInt32(off + 4, bmWidth, true);
    view.setInt32(off + 8, bmHeight, true);
    view.setUint16(off + 12, 1, true);
    view.setUint16(off + 14, bitCount, true);
    view.setUint32(off + 20, sizeImage, true);

    return buf;
}

const ILC_MASK = 0x0001;
const S_OK = 0;

function computeImageListDibSize(count: number, cx: number, cy: number, bitCount: number): number {
    const bmWidth = count * (cx || 1);
    const bmHeight = cy || 1;
    if (bmWidth <= 0 || bmHeight <= 0) return 14 + 40;
    const stride = ((bmWidth * bitCount + 31) >> 5) << 2;
    return 14 + 40 + stride * bmHeight;
}

function parseIlHead(mem: Uint8Array, ptr: number): ImageListState | null {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    if (view.getUint16(ptr, true) !== 0x4c49) return null;
    if (view.getUint16(ptr + 2, true) !== 0x0101) return null;
    return {
        count: view.getUint16(ptr + 4, true),
        cInitial: view.getUint16(ptr + 6, true),
        cGrow: view.getUint16(ptr + 8, true) || 4,
        cx: view.getUint16(ptr + 10, true) || 1,
        cy: view.getUint16(ptr + 12, true) || 1,
        bkColor: view.getUint32(ptr + 14, true),
        flags: view.getUint16(ptr + 18, true) || 0x0020,
    };
}

function suspendForIStreamRead(
    ctx: any,
    mem: Uint8Array,
    pstm: number,
    buffer: number,
    pcbRead: number,
    bytes: number,
    stackCleanup: number,
    frameId: number,
    source: string,
    onDone: (hr: number) => number | null,
): ThunkResult | null {
    const process = System.getInstance().process;
    const callbackManager = process?.dispatcher?.callbackManager;
    if (!process || !callbackManager) return null;
    const readAddr = readGuestVtblSlot(mem, pstm, 3);
    if (!readAddr) return null;
    const { callbackId } = callbackManager.invokeCallback(
        readAddr,
        [pstm, buffer, bytes, pcbRead],
        16,
        onDone,
        false,
        source,
        frameId,
    );
    return {
        value: 0,
        suspendedForCallback: true,
        callbackId,
        stackCleanup,
    };
}

export class Comctl32 implements IModule {
    name = "comctl32";
    exports: Record<string, ThunkImplementation> = {};

    private nextImageListHandle = 1;
    private nextIconHandle = 0x2000;
    private imageLists: Map<number, ImageListState> = new Map();

    // CreatePropertySheetPageA / DestroyPropertySheetPage handle table.
    // Key: opaque HPROPSHEETPAGE handle (JS-side integer).
    // Value: guest pointer to a heap-allocated copy of the PROPSHEETPAGE struct.
    private nextPropPageHandle = 0x8000;
    private propPageHandles: Map<number, number> = new Map();

    initialize(_process: Process): void {
        this.exports["InitCommonControls"] = (_ctx, _mem, _args) =>
            initCommonControls() ? 1 : 0;

        this.exports["InitCommonControlsEx"] = (_ctx, mem, args) => {
            const picce = args[0] >>> 0;
            if (!picce || picce + INITCOMMONCONTROLSEX_SIZE > mem.length) {
                return 0;
            }
            const dwSize = Mem.readUint32(picce) ?? 0;
            if (dwSize !== INITCOMMONCONTROLSEX_SIZE) {
                Logger.warn(LogCategory.SYSTEM,
                    `InitCommonControlsEx: bad dwSize=${dwSize} (expected ${INITCOMMONCONTROLSEX_SIZE})`);
                return 0;
            }
            const dwIcc = Mem.readUint32(picce + 4) ?? 0;
            return initCommonControlsEx(dwIcc) ? 1 : 0;
        };

        this.exports["ord_17"] = this.exports["InitCommonControls"]; // InitCommonControls (ordinal 17)

        this.exports["ImageList_Create"] = (_ctx, _mem, args) => {
            const cx = args[0] >>> 0;
            const cy = args[1] >>> 0;
            const flags = args[2] >>> 0;
            const cInitial = args[3] >>> 0;
            const cGrow = args[4] >>> 0;
            const handle = this.nextImageListHandle++;
            this.imageLists.set(handle, {
                count: 0,
                bkColor: 0xFFFFFFFF,
                cx,
                cy,
                flags: flags || 0x0020, // ILC_COLOR32
                cGrow: cGrow || 4,
                cInitial: cInitial || 4,
            });
            return handle;
        };

        this.exports["ImageList_Destroy"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            if (!this.imageLists.has(handle)) {
                return 0;
            }
            this.imageLists.delete(handle);
            return 1;
        };

        this.exports["ImageList_Add"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const list = this.imageLists.get(handle);
            if (!list) return -1;
            const index = list.count;
            list.count += 1;
            return index;
        };

        this.exports["ImageList_AddMasked"] = this.exports["ImageList_Add"];

        this.exports["ImageList_GetImageCount"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const list = this.imageLists.get(handle);
            return list ? list.count : 0;
        };

        this.exports["ImageList_Remove"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const index = args[1] | 0;
            const list = this.imageLists.get(handle);
            if (!list) return 0;
            if (index === -1) {
                list.count = 0;
                return 1;
            }
            if (index >= 0 && index < list.count) {
                list.count = Math.max(0, list.count - 1);
                return 1;
            }
            return 0;
        };

        this.exports["ImageList_Replace"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const index = args[1] | 0;
            const list = this.imageLists.get(handle);
            if (!list) return 0;
            if (index >= list.count) {
                list.count = index + 1;
            }
            return 1;
        };

        this.exports["ImageList_ReplaceIcon"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const index = args[1] | 0;
            const list = this.imageLists.get(handle);
            if (!list) return -1;
            if (index >= list.count) {
                list.count = index + 1;
            }
            return index;
        };

        this.exports["ImageList_GetIcon"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            if (!this.imageLists.has(handle)) return 0;
            return this.nextIconHandle++;
        };

        this.exports["ImageList_Draw"] = () => 1;

        this.exports["ImageList_SetBkColor"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const color = args[1] >>> 0;
            const list = this.imageLists.get(handle);
            if (!list) return 0xFFFFFFFF;
            const prev = list.bkColor;
            list.bkColor = color;
            return prev;
        };

        this.exports["ImageList_GetBkColor"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const list = this.imageLists.get(handle);
            return list ? list.bkColor : 0xFFFFFFFF;
        };

        this.exports["ImageList_SetIconSize"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const cx = args[1] >>> 0;
            const cy = args[2] >>> 0;
            const list = this.imageLists.get(handle);
            if (!list) return 0;
            list.cx = cx;
            list.cy = cy;
            return 1;
        };

        // HRESULT DllGetVersion(DLLVERSIONINFO *pdvi)
        // struct DLLVERSIONINFO { DWORD cbSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformID }
        this.exports["DllGetVersion"] = (_ctx, mem, args) => {
            const pdvi = args[0] >>> 0;
            if (!pdvi || pdvi + 20 > mem.length) return 0x80004005; // E_FAIL
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const cbSize = view.getUint32(pdvi, true);
            if (cbSize < 20) return 0x80004005; // E_FAIL
            view.setUint32(pdvi + 4, 5, true);   // dwMajorVersion = 5
            view.setUint32(pdvi + 8, 81, true);  // dwMinorVersion = 81
            view.setUint32(pdvi + 12, 4704, true); // dwBuildNumber
            view.setUint32(pdvi + 16, 2, true);  // DLLVER_PLATFORM_NT
            Logger.verbose(LogCategory.SYSTEM, `comctl32:DllGetVersion -> 5.81`);
            return 0; // S_OK
        };

        // ImageList drag-and-drop stubs
        this.exports["ImageList_BeginDrag"] = () => 1;
        this.exports["ImageList_EndDrag"] = () => 0;
        this.exports["ImageList_DragEnter"] = () => 1;
        this.exports["ImageList_DragMove"] = () => 1;
        this.exports["ImageList_DragLeave"] = () => 1;
        this.exports["ImageList_DragShowNolock"] = () => 1;

        // BOOL ImageList_Write(HIMAGELIST himl, IStream *pstm)
        this.exports["ImageList_Write"] = (ctx, mem, args): number | ThunkResult => {
            const handle = args[0] >>> 0;
            const pstm = args[1] >>> 0;
            const list = this.imageLists.get(handle);
            if (!list || !pstm) return 0;

            const system = System.getInstance();
            const process = system.process;
            if (!process) return 0;

            const blob = buildImageListStreamBlob(list);
            const dataPtr = process.memory.alloc(blob.length);
            mem.set(blob, dataPtr);

            const writeAddr = readGuestVtblSlot(mem, pstm, 4); // ISequentialStream::Write
            const callbackManager = process.dispatcher?.callbackManager;
            if (!writeAddr || !callbackManager) {
                process.memory.free(dataPtr);
                return 1;
            }

            const pcbWritten = process.memory.alloc(4);
            const STACK_CLEANUP = 8;
            callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
            const { callbackId } = callbackManager.invokeCallback(
                writeAddr,
                [pstm, dataPtr, blob.length, pcbWritten],
                16,
                (hr) => {
                    process.memory.free(dataPtr);
                    process.memory.free(pcbWritten);
                    return (hr >>> 0) === 0 ? 1 : 0;
                },
                false,
                "ImageList_Write"
            );

            return {
                value: 1,
                suspendedForCallback: true,
                callbackId,
                stackCleanup: STACK_CLEANUP,
            };
        };

        // HIMAGELIST ImageList_Read(IStream *pstm)
        this.exports["ImageList_Read"] = (ctx, mem, args): number | ThunkResult => {
            const pstm = args[0] >>> 0;
            if (!pstm) return 0;

            const system = System.getInstance();
            const process = system.process;
            const callbackManager = process?.dispatcher?.callbackManager;
            if (!process || !callbackManager) return 0;

            const STACK_CLEANUP = 4;
            const ilHeadPtr = process.memory.alloc(ILHEAD_SIZE);
            const pcbRead = process.memory.alloc(4);
            const comctl = this;

            const fail = (): number => {
                process.memory.free(ilHeadPtr);
                process.memory.free(pcbRead);
                return 0;
            };

            const frameId = callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP, "ImageList_Read");
            if (!frameId) return fail();

            const suspended = suspendForIStreamRead(
                ctx,
                mem,
                pstm,
                ilHeadPtr,
                pcbRead,
                ILHEAD_SIZE,
                STACK_CLEANUP,
                frameId,
                "ImageList_Read",
                (hr) => {
                    if ((hr >>> 0) !== S_OK) return fail();
                    const state = parseIlHead(mem, ilHeadPtr);
                    process.memory.free(ilHeadPtr);
                    if (!state) return fail();

                    let discardSize = computeImageListDibSize(state.count, state.cx, state.cy, 32);
                    if (state.flags & ILC_MASK) {
                        discardSize += computeImageListDibSize(state.count, state.cx, state.cy, 1);
                    }

                    const finishOk = (): number => {
                        const handle = comctl.nextImageListHandle++;
                        comctl.imageLists.set(handle, state);
                        process.memory.free(pcbRead);
                        return handle;
                    };

                    if (discardSize <= 14 + 40) {
                        return finishOk();
                    }

                    const scratch = process.memory.alloc(discardSize);
                    const readAddr = readGuestVtblSlot(mem, pstm, 3);
                    if (!readAddr) {
                        process.memory.free(scratch);
                        return fail();
                    }

                    callbackManager.invokeCallback(
                        readAddr,
                        [pstm, scratch, discardSize, pcbRead],
                        16,
                        (hr2) => {
                            process.memory.free(scratch);
                            if ((hr2 >>> 0) !== S_OK) {
                                process.memory.free(pcbRead);
                                return 0;
                            }
                            return finishOk();
                        },
                        false,
                        "ImageList_Read-dib",
                        frameId,
                    );
                    return null;
                },
            );

            if (!suspended) return fail();
            return suspended;
        };

        // Remaining ImageList_* exports — bulk stubs so GetProcAddress probes (e.g. Cossacks
        // cossacks.dll bind table) don't NULL-bail one export at a time.
        const allocImageList = (cx = 16, cy = 16): number => {
            const handle = this.nextImageListHandle++;
            this.imageLists.set(handle, {
                count: 0,
                bkColor: 0xFFFFFFFF,
                cx,
                cy,
                flags: 0x0020,
                cGrow: 4,
                cInitial: 4,
            });
            return handle;
        };

        const cloneImageList = (srcHandle: number): number => {
            const src = this.imageLists.get(srcHandle);
            if (!src) return 0;
            const handle = this.nextImageListHandle++;
            this.imageLists.set(handle, { ...src });
            return handle;
        };

        const replaceIcon = this.exports["ImageList_ReplaceIcon"] as ThunkImplementation;

        const imageListBulk: Record<string, ThunkImplementation> = {
            ImageList_DrawEx: () => 1,
            ImageList_DrawIndirect: () => 1,
            ImageList_AddIcon: (ctx, mem, args) => replaceIcon(ctx, mem, [args[0], 0xffffffff, args[2]]),
            ImageList_SetImageCount: (_ctx, _mem, args) => {
                const list = this.imageLists.get(args[0] >>> 0);
                if (!list) return 0;
                list.count = args[1] >>> 0;
                return 1;
            },
            ImageList_SetOverlayImage: () => 1,
            ImageList_Copy: () => 1,
            ImageList_SetDragCursorImage: () => 1,
            ImageList_GetDragImage: () => 0,
            ImageList_LoadImageA: (_ctx, _mem, args) => allocImageList(args[2] >>> 0, args[2] >>> 0),
            ImageList_LoadImageW: (_ctx, _mem, args) => allocImageList(args[2] >>> 0, args[2] >>> 0),
            ImageList_LoadImage: (_ctx, _mem, args) => allocImageList(args[2] >>> 0, args[2] >>> 0),
            ImageList_Duplicate: (_ctx, _mem, args) => cloneImageList(args[0] >>> 0),
            ImageList_Merge: () => allocImageList(),
            ImageList_GetImageInfo: (_ctx, mem, args) => {
                const lpImageInfo = args[2] >>> 0;
                if (lpImageInfo && lpImageInfo + 52 <= mem.length) {
                    mem.fill(0, lpImageInfo, lpImageInfo + 52);
                }
                return 1;
            },
            ImageList_WriteEx: (ctx, mem, args) => {
                const write = this.exports["ImageList_Write"] as ThunkImplementation;
                return write(ctx, mem, [args[0], args[2]]);
            },
            ImageList_ReadEx: () => 0x80004001, // E_NOTIMPL — use ImageList_Read if needed
        };

        for (const [name, impl] of Object.entries(imageListBulk)) {
            if (!this.exports[name]) {
                this.exports[name] = impl;
            }
        }

        // BOOL _TrackMouseEvent(LPTRACKMOUSEEVENT lpEventTrack)
        // comctl32 forwarding helper; mirrors user32 TrackMouseEvent behavior.
        const trackMouseEventImpl: ThunkImplementation = (_ctx, mem, args) => {
            const lpEventTrack = args[0] >>> 0;
            if (lpEventTrack && lpEventTrack + 16 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const cbSize = view.getUint32(lpEventTrack + 0, true);
                if (cbSize >= 16) {
                    const dwFlags = view.getUint32(lpEventTrack + 4, true);
                    const hwndTrack = view.getUint32(lpEventTrack + 8, true);
                    const dwHoverTime = view.getUint32(lpEventTrack + 12, true);
                    System.getInstance().inputManager.trackMouseEvent(hwndTrack, dwFlags, dwHoverTime);
                }
            }
            return { value: 1, stackCleanup: 4 }; // TRUE
        };
        this.exports["_TrackMouseEvent"] = trackMouseEventImpl;
        this.exports["TrackMouseEvent"] = trackMouseEventImpl;

        // HPROPSHEETPAGE CreatePropertySheetPageA(LPCPROPSHEETPAGEA lppsp)
        // Copies the caller's PROPSHEETPAGE struct onto the guest heap and returns
        // an opaque handle.  DestroyPropertySheetPage frees it.
        // When PropertySheetA is called WITHOUT PSH_PROPSHEETPAGE the ppsp array
        // contains these handles; we dereference them back to the struct pointer.
        this.exports["CreatePropertySheetPageA"] = (_ctx, mem, args) => {
            const lppsp = args[0] >>> 0;
            if (!lppsp) {
                Logger.warn(LogCategory.SYSTEM, "CreatePropertySheetPageA: NULL lppsp");
                return 0;
            }

            const system = System.getInstance();
            const process = system.process;
            if (!process) return 0;

            // Read dwSize from the struct so we know how many bytes to copy.
            const dwSize = (Mem.readUint32(lppsp) ?? 0) >>> 0;
            const copySize = dwSize >= 0x28 ? dwSize : 0x30; // PROPSHEETPAGE minimum is 0x28 bytes
            if (lppsp + copySize > mem.length) {
                Logger.warn(LogCategory.SYSTEM,
                    `CreatePropertySheetPageA: struct at 0x${lppsp.toString(16)} overflows mem (size=${copySize})`);
                return 0;
            }

            // Allocate a host-heap copy so the page survives the caller's stack frame.
            const guestCopy = process.memory.alloc(copySize);
            mem.copyWithin(guestCopy, lppsp, lppsp + copySize);

            const handle = this.nextPropPageHandle++;
            this.propPageHandles.set(handle, guestCopy);

            Logger.verbose(LogCategory.SYSTEM,
                `CreatePropertySheetPageA: lppsp=0x${lppsp.toString(16)}, size=${copySize} → hPage=0x${handle.toString(16)}`);
            return handle;
        };

        // CreatePropertySheetPageW — identical shape; treat as ANSI for HLE purposes.
        this.exports["CreatePropertySheetPageW"] = this.exports["CreatePropertySheetPageA"];

        // BOOL DestroyPropertySheetPage(HPROPSHEETPAGE hPSPage)
        this.exports["DestroyPropertySheetPage"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const guestCopy = this.propPageHandles.get(handle);
            if (guestCopy === undefined) {
                Logger.warn(LogCategory.SYSTEM,
                    `DestroyPropertySheetPage: unknown handle 0x${handle.toString(16)}`);
                return 0; // FALSE
            }

            const system = System.getInstance();
            const process = system.process;
            process?.memory.free(guestCopy);
            this.propPageHandles.delete(handle);

            Logger.verbose(LogCategory.SYSTEM,
                `DestroyPropertySheetPage: freed hPage=0x${handle.toString(16)}`);
            return 1; // TRUE
        };

        // PropertySheetA/W — the real sheet lives in comctl32/propsheet.ts.
        // `resolveHandle` closes over this module's HPROPSHEETPAGE table so the
        // sheet never needs to know how a handle maps to a guest struct.
        const resolveHandle = (hPage: number): number =>
            this.propPageHandles.get(hPage >>> 0) ?? 0;

        this.exports["PropertySheetA"] = (ctx, mem, args) =>
            propertySheet(ctx, mem, args, false, resolveHandle);
        this.exports["PropertySheetW"] = (ctx, mem, args) =>
            propertySheet(ctx, mem, args, true, resolveHandle);

        // The sheet frame's DLGPROC needs a guest-visible code address; registering
        // it as an export is what gives the thunk generator a stub to hand out.
        // Nothing imports this name — DWLP_DLGPROC is the only way to observe it.
        this.exports["PropertySheetDlgProc"] = propSheetDlgProc;

        this.exports["ImageList_GetIconSize"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const pcx = args[1] >>> 0;
            const pcy = args[2] >>> 0;
            const list = this.imageLists.get(handle);
            if (!list) return 0;
            if (pcx) Mem.writeUint32(pcx, list.cx);
            if (pcy) Mem.writeUint32(pcy, list.cy);
            return 1;
        };

        registerFlatSbExports(this.exports);
    }

    reset(): void {
        this.nextImageListHandle = 1;
        this.nextIconHandle = 0x2000;
        this.imageLists.clear();
        this.nextPropPageHandle = 0x8000;
        this.propPageHandles.clear();
        resetPropSheetState();
        resetFlatSbState();
    }
}
