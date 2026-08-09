import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { Mem } from "../core/memory/mem-accessor";
import { TypeLibRuntime } from "../core/com/typelib/typelib-objects";
import { createSafeArrayExports } from "./oleaut32-safearray";
import { createVariantOpExports } from "./oleaut32-variant-ops";

const S_OK = 0x00000000;
const E_INVALIDARG = 0x80070057;
const E_POINTER = 0x80004003;
const DISP_E_TYPEMISMATCH = 0x80020005;
const VT_EMPTY = 0;
const VT_NULL = 1;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_BSTR = 8;
const VT_BOOL = 11;
const VT_UI4 = 19;
const VT_BYREF = 0x4000;
const VT_TYPEMASK = 0x0fff;

export class Oleaut32 implements IModule {
    name = "oleaut32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private typeLibRuntime = new TypeLibRuntime();
    private safeArray = createSafeArrayExports();

    initialize(process: Process): void {
        this.process = process;
        const alloc = (size: number) => System.getInstance().process?.memory?.alloc(size) ?? 0;

        this.typeLibRuntime.initialize(process);

        // ---- BSTR functions ----

        this.exports["ord_2"] = (ctx, mem, args) => {
            const psz = args[0] >>> 0;
            if (!psz) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            let len = 0;
            while (psz + len * 2 + 1 < mem.length) {
                if (view.getUint16(psz + len * 2, true) === 0) break;
                len++;
            }

            const totalSize = 4 + len * 2 + 2;
            const block = alloc(totalSize);
            if (!block) return 0;

            view.setUint32(block, len * 2, true);
            for (let i = 0; i < len; i++) {
                view.setUint16(block + 4 + i * 2, view.getUint16(psz + i * 2, true), true);
            }
            view.setUint16(block + 4 + len * 2, 0, true);
            return block + 4;
        };

        this.exports["ord_4"] = (ctx, mem, args) => {
            const psz = args[0] >>> 0;
            const len = args[1] >>> 0;

            const totalSize = 4 + len * 2 + 2;
            const block = alloc(totalSize);
            if (!block) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(block, len * 2, true);
            if (psz) {
                for (let i = 0; i < len; i++) {
                    view.setUint16(block + 4 + i * 2, view.getUint16(psz + i * 2, true), true);
                }
            } else {
                for (let i = 0; i < len; i++) {
                    view.setUint16(block + 4 + i * 2, 0, true);
                }
            }
            view.setUint16(block + 4 + len * 2, 0, true);
            return block + 4;
        };

        const sysAllocStringLen = this.exports["ord_4"];

        const sysReAllocStringLen: ThunkImplementation = (_ctx, mem, args) => {
            const pbstr = args[0] >>> 0;
            const psz = args[1] >>> 0;
            const len = args[2] >>> 0;
            if (len >= 0x7ffffff9) return 0;
            if (!pbstr || pbstr + 4 > mem.length) return 0;

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const oldBstr = view.getUint32(pbstr, true);

            if (oldBstr) {
                const newByteLen = len * 2;
                const totalSize = 4 + newByteLen + 2;
                const newBlock = alloc(totalSize);
                if (!newBlock) return 0;

                view.setUint32(newBlock, newByteLen, true);
                if (psz && psz !== oldBstr) {
                    for (let i = 0; i < len; i++) {
                        view.setUint16(newBlock + 4 + i * 2, view.getUint16(psz + i * 2, true), true);
                    }
                } else if (oldBstr >= 4) {
                    const oldBlock = oldBstr - 4;
                    const oldByteLen = view.getUint32(oldBlock, true);
                    const oldCharLen = oldByteLen / 2;
                    const copyChars = Math.min(oldCharLen, len);
                    for (let i = 0; i < copyChars; i++) {
                        view.setUint16(newBlock + 4 + i * 2, view.getUint16(oldBstr + i * 2, true), true);
                    }
                    for (let i = copyChars; i < len; i++) {
                        view.setUint16(newBlock + 4 + i * 2, 0, true);
                    }
                }
                view.setUint16(newBlock + 4 + len * 2, 0, true);

                const newBstr = newBlock + 4;
                view.setUint32(pbstr, newBstr, true);
                System.getInstance().process?.memory?.free(oldBstr - 4);
                return 1;
            }

            const newBstr = Number(sysAllocStringLen(_ctx, mem, [psz, len])) >>> 0;
            view.setUint32(pbstr, newBstr, true);
            return 1;
        };
        this.exports["ord_5"] = sysReAllocStringLen;
        this.exports["SysReAllocStringLen"] = sysReAllocStringLen;

        this.exports["ord_6"] = (ctx, mem, args) => {
            this.sysFreeString(args[0] >>> 0);
            return 0;
        };
        this.exports["SysFreeString"] = this.exports["ord_6"];
        this.exports["ord_7"] = (ctx, mem, args) => {
            const bstr = args[0] >>> 0;
            if (!bstr || bstr < 4) return 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            return view.getUint32(bstr - 4, true) / 2;
        };

        // ---- VARIANT functions ----

        this.exports["ord_8"] = (ctx, mem, args) => {
            const pvarg = args[0] >>> 0;
            if (pvarg && pvarg + 16 <= mem.length) {
                mem.fill(0, pvarg, pvarg + 16);
            }
            return 0;
        };

        this.exports["ord_9"] = (ctx, mem, args) => {
            const pvarg = args[0] >>> 0;
            if (!pvarg || pvarg + 16 > mem.length) return E_INVALIDARG;
            this.variantClear(mem, pvarg);
            return S_OK;
        };
        this.exports["VariantClear"] = this.exports["ord_9"];

        this.exports["ord_10"] = (ctx, mem, args) => {
            const pvargDest = args[0] >>> 0;
            const pvargSrc = args[1] >>> 0;
            if (!pvargDest || !pvargSrc) return E_INVALIDARG;
            if (pvargDest + 16 > mem.length || pvargSrc + 16 > mem.length) return E_INVALIDARG;
            return this.variantCopy(mem, pvargDest, pvargSrc);
        };
        this.exports["VariantCopy"] = this.exports["ord_10"];

        // HRESULT VariantCopyInd(VARIANTARG* pvargDest, const VARIANTARG* pvargSrc)
        // Same as VariantCopy except a VT_BYREF source is dereferenced first, so the
        // destination owns a value rather than a pointer into the caller's storage.
        this.exports["ord_11"] = (ctx, mem, args) => {
            const pvargDest = args[0] >>> 0;
            const pvargSrc = args[1] >>> 0;
            if (!pvargDest || !pvargSrc) return E_INVALIDARG;
            if (pvargDest + 16 > mem.length || pvargSrc + 16 > mem.length) return E_INVALIDARG;
            return this.variantCopyInd(mem, pvargDest, pvargSrc);
        };
        this.exports["VariantCopyInd"] = this.exports["ord_11"];

        const variantChangeType = (ctx: unknown, mem: Uint8Array, args: number[]) => {
            const pvargDest = args[0] >>> 0;
            const pvargSrc = args[1] >>> 0;
            const vtNew = args[2] & VT_TYPEMASK;
            if (!pvargDest || !pvargSrc) return E_INVALIDARG;
            if (pvargDest + 16 > mem.length || pvargSrc + 16 > mem.length) return E_INVALIDARG;
            return this.variantChangeType(mem, pvargDest, pvargSrc, vtNew);
        };
        this.exports["ord_12"] = variantChangeType;
        this.exports["VariantChangeType"] = variantChangeType;
        this.exports["VariantChangeTypeEx"] = (ctx, mem, args) =>
            variantChangeType(ctx, mem, [args[0], args[1], args[3]]);

        // ---- Active Object Registration ----

        this.exports["ord_33"] = (ctx, mem, args) => {
            const pdwRegister = args[3] >>> 0;
            if (pdwRegister) Mem.writeUint32(pdwRegister, 0x2000);
            return S_OK;
        };

        this.exports["ord_34"] = () => S_OK;

        // ---- Type Library ----

        const loadTypeLibImpl = (ctx: unknown, mem: Uint8Array, args: number[]) => {
            const szFile = args[0] >>> 0;
            const pptlib = args[1] >>> 0;
            const path = szFile ? this.readOleString(mem, szFile) : "";
            Logger.log(LogCategory.COM, `LoadTypeLib("${path}")`);
            if (!pptlib) return E_POINTER;
            return this.typeLibRuntime.loadTypeLib(path, pptlib);
        };

        this.exports["ord_161"] = loadTypeLibImpl;
        this.exports["LoadTypeLib"] = loadTypeLibImpl;

        this.exports["LoadTypeLibEx"] = (ctx, mem, args) => {
            return loadTypeLibImpl(ctx, mem, [args[0], args[2]]);
        };

        this.exports["ord_162"] = (ctx, mem, args) => {
            const ptlib = args[0] >>> 0;
            const szFullPath = args[1] >>> 0;
            const path = szFullPath ? this.readOleString(mem, szFullPath) : "";
            return this.typeLibRuntime.registerTypeLib(ptlib, path);
        };
        this.exports["RegisterTypeLib"] = this.exports["ord_162"];

        this.exports["ord_163"] = (ctx, mem, args) => {
            const pptlib = args[4] >>> 0;
            if (!pptlib) return E_POINTER;
            return this.typeLibRuntime.loadRegTypeLib(args[0] >>> 0, mem, pptlib);
        };
        this.exports["LoadRegTypeLib"] = this.exports["ord_163"];

        // ---- Error Info ----

        this.exports["ord_200"] = (ctx, mem, args) => {
            const pperrinfo = args[0] >>> 0;
            if (pperrinfo) Mem.writeUint32(pperrinfo, 0);
            return 0x00000001;
        };

        this.exports["ord_201"] = () => S_OK;

        this.exports["ord_202"] = (ctx, mem, args) => {
            const pperrinfo = args[0] >>> 0;
            if (pperrinfo) Mem.writeUint32(pperrinfo, 0);
            return 0x80004001;
        };

        Object.assign(this.exports, this.safeArray.exports);
        Object.assign(this.exports, createVariantOpExports());
    }

    reset(): void {
        this.typeLibRuntime.reset();
        this.safeArray.reset();
    }

    recreateVTables(): void {
        if (!this.process) return;
        this.typeLibRuntime.recreateVTables(this.process);
    }

    private readWide(mem: Uint8Array, addr: number): string {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let out = "";
        let p = addr;
        while (p + 1 < mem.length) {
            const ch = view.getUint16(p, true);
            if (ch === 0) break;
            out += String.fromCharCode(ch);
            p += 2;
        }
        return out;
    }

    private sysFreeString(bstr: number): void {
        if (!bstr || bstr < 4) return;
        const block = (bstr - 4) >>> 0;
        System.getInstance().process?.memory?.free(block);
    }

    private readVariantType(mem: Uint8Array, pvarg: number): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        return view.getUint16(pvarg, true) & VT_TYPEMASK;
    }

    private variantClear(mem: Uint8Array, pvarg: number): void {
        const vt = this.readVariantType(mem, pvarg);
        if (vt === VT_BSTR) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const bstr = view.getUint32(pvarg + 8, true);
            this.sysFreeString(bstr);
        }
        mem.fill(0, pvarg, pvarg + 16);
    }

    private copyBstr(mem: Uint8Array, srcBstr: number): number {
        const alloc = (size: number) => System.getInstance().process?.memory?.alloc(size) ?? 0;
        if (!srcBstr) return 0;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const byteLen = view.getUint32(srcBstr - 4, true);
        const charLen = byteLen / 2;
        const totalSize = 4 + byteLen + 2;
        const block = alloc(totalSize);
        if (!block) return 0;
        view.setUint32(block, byteLen, true);
        for (let i = 0; i < charLen; i++) {
            view.setUint16(block + 4 + i * 2, view.getUint16(srcBstr + i * 2, true), true);
        }
        view.setUint16(block + 4 + byteLen, 0, true);
        return block + 4;
    }

    private variantCopy(mem: Uint8Array, dest: number, src: number): number {
        this.variantClear(mem, dest);
        const srcVt = this.readVariantType(mem, src);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint16(dest, srcVt, true);
        if (srcVt === VT_BSTR) {
            const srcBstr = view.getUint32(src + 8, true);
            const newBstr = this.copyBstr(mem, srcBstr);
            view.setUint32(dest + 8, newBstr, true);
            return S_OK;
        }
        mem.set(mem.subarray(src + 2, src + 16), dest + 2);
        return S_OK;
    }

    /** VariantCopy after resolving one level of VT_BYREF indirection on the source. */
    private variantCopyInd(mem: Uint8Array, dest: number, src: number): number {
        const srcVt = this.readVariantType(mem, src);
        if (!(srcVt & VT_BYREF)) return this.variantCopy(mem, dest, src);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const vt = srcVt & VT_TYPEMASK;
        const ref = view.getUint32(src + 8, true) >>> 0;
        if (!ref) return E_INVALIDARG;

        this.variantClear(mem, dest);
        view.setUint16(dest, vt, true);
        switch (vt) {
            case VT_I2: view.setInt16(dest + 8, view.getInt16(ref, true), true); return S_OK;
            case VT_I4:
            case VT_UI4: view.setUint32(dest + 8, view.getUint32(ref, true), true); return S_OK;
            case VT_R4: view.setFloat32(dest + 8, view.getFloat32(ref, true), true); return S_OK;
            case VT_R8: view.setFloat64(dest + 8, view.getFloat64(ref, true), true); return S_OK;
            case VT_BOOL: view.setInt16(dest + 8, view.getInt16(ref, true), true); return S_OK;
            case VT_BSTR:
                // A BYREF BSTR points at the BSTR variable, not at the characters.
                view.setUint32(dest + 8, this.copyBstr(mem, view.getUint32(ref, true) >>> 0), true);
                return S_OK;
            case VT_EMPTY:
            case VT_NULL: return S_OK;
            default:
                // VT_VARIANT|VT_BYREF and the interface types need a second indirection or
                // an AddRef we cannot fake; failing is safer than handing back a pointer
                // the caller will free as a value.
                view.setUint16(dest, VT_EMPTY, true);
                Logger.warn(LogCategory.SYSTEM, `VariantCopyInd: unsupported byref type vt=0x${vt.toString(16)}`);
                return E_INVALIDARG;
        }
    }

    private variantChangeType(mem: Uint8Array, dest: number, src: number, vtNew: number): number {
        const srcVt = this.readVariantType(mem, src);
        if (srcVt === vtNew) {
            return this.variantCopy(mem, dest, src);
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const srcVal = view.getUint32(src + 8, true);
        const srcR8 = view.getFloat64(src + 8, true);

        this.variantClear(mem, dest);
        view.setUint16(dest, vtNew, true);

        const toI4 = (): number | null => {
            switch (srcVt) {
                case VT_I2: return view.getInt16(src + 8, true);
                case VT_I4: return view.getInt32(src + 8, true);
                case VT_UI4: return view.getUint32(src + 8, true) | 0;
                case VT_BOOL: return srcVal ? -1 : 0;
                case VT_R4: return view.getFloat32(src + 8, true) | 0;
                case VT_R8: return srcR8 | 0;
                case VT_BSTR: {
                    const s = this.readWide(mem, srcVal);
                    const n = parseInt(s, 10);
                    return Number.isNaN(n) ? null : n;
                }
                default: return null;
            }
        };

        const toR8 = (): number | null => {
            switch (srcVt) {
                case VT_I2: return view.getInt16(src + 8, true);
                case VT_I4: return view.getInt32(src + 8, true);
                case VT_UI4: return view.getUint32(src + 8, true);
                case VT_BOOL: return srcVal ? 1 : 0;
                case VT_R4: return view.getFloat32(src + 8, true);
                case VT_R8: return srcR8;
                case VT_BSTR: {
                    const s = this.readWide(mem, srcVal);
                    const n = parseFloat(s);
                    return Number.isNaN(n) ? null : n;
                }
                default: return null;
            }
        };

        const toBstr = (): number | null => {
            let text = "";
            switch (srcVt) {
                case VT_I2: text = String(view.getInt16(src + 8, true)); break;
                case VT_I4: text = String(view.getInt32(src + 8, true)); break;
                case VT_UI4: text = String(view.getUint32(src + 8, true)); break;
                case VT_BOOL: text = srcVal ? "-1" : "0"; break;
                case VT_R4: text = String(view.getFloat32(src + 8, true)); break;
                case VT_R8: text = String(srcR8); break;
                case VT_BSTR: return this.copyBstr(mem, srcVal);
                default: return null;
            }
            const wcharLen = text.length;
            const alloc = (size: number) => System.getInstance().process?.memory?.alloc(size) ?? 0;
            const totalSize = 4 + wcharLen * 2 + 2;
            const block = alloc(totalSize);
            if (!block) return null;
            view.setUint32(block, wcharLen * 2, true);
            for (let i = 0; i < wcharLen; i++) {
                view.setUint16(block + 4 + i * 2, text.charCodeAt(i), true);
            }
            view.setUint16(block + 4 + wcharLen * 2, 0, true);
            return block + 4;
        };

        switch (vtNew) {
            case VT_I4:
            case VT_UI4: {
                const v = toI4();
                if (v === null) return DISP_E_TYPEMISMATCH;
                view.setInt32(dest + 8, v, true);
                return S_OK;
            }
            case VT_R8: {
                const v = toR8();
                if (v === null) return DISP_E_TYPEMISMATCH;
                view.setFloat64(dest + 8, v, true);
                return S_OK;
            }
            case VT_BSTR: {
                const bstr = toBstr();
                if (!bstr) return DISP_E_TYPEMISMATCH;
                view.setUint32(dest + 8, bstr, true);
                return S_OK;
            }
            case VT_BOOL: {
                const v = toI4();
                if (v === null) return DISP_E_TYPEMISMATCH;
                view.setUint32(dest + 8, v ? 0xffffffff : 0, true);
                return S_OK;
            }
            default:
                return DISP_E_TYPEMISMATCH;
        }
    }

    private readOleString(mem: Uint8Array, addr: number): string {
        if (!addr || addr >= mem.length) return "";
        let looksWide = true;
        for (let i = 0; i < 8 && addr + i * 2 + 1 < mem.length; i++) {
            const lo = mem[addr + i * 2];
            const hi = mem[addr + i * 2 + 1];
            if (lo === 0 && i > 0) break;
            if (hi !== 0) {
                looksWide = false;
                break;
            }
        }
        if (looksWide) return this.readWide(mem, addr);
        let out = "";
        for (let p = addr; p < mem.length; p++) {
            const ch = mem[p];
            if (ch === 0) break;
            out += String.fromCharCode(ch);
        }
        return out;
    }
}
