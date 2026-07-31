/**
 * MSVCP60 — MSVC 6.0 C++ standard library (minimal std::basic_string<char> HLE).
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";
import { Msvcrt } from "./msvcrt";
import {
    vc6StringAppendCharCount,
    vc6StringAppendCStrCount,
    vc6StringAssignCStrCount,
    vc6StringAssignRange,
    vc6StringConcat,
    vc6StringConcatCStrLeft,
    vc6StringConcatCStrRight,
    vc6StringCopy,
    vc6StringCopyCtor,
    vc6StringCtorCStr,
    vc6StringCStr,
    vc6StringEquals,
    vc6StringEqualsCStr,
    vc6StringErase,
    vc6StringEos,
    vc6StringFind,
    vc6StringFindFirstOf,
    vc6StringFindLastOf,
    vc6StringGrow,
    vc6StringInsert,
    vc6StringLess,
    vc6StringSplit,
    vc6StringTidy,
    type CppStringHeap,
} from "./crt-cppstring-vc6";

const BS = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std";
const BS0 = "?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0";

export class Msvcp60 implements IModule {
    name = "msvcp60";
    exports: Record<string, ThunkImplementation> = {};

    private heap!: CppStringHeap;
    private msvcrt!: Msvcrt;
    private process!: Process;
    private nullstrAddr = 0;
    private nposAddr = 0;
    private refcntAddr = 0;
    private logicErrorVtableAddr = 0;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    private ensureRuntimeStorage(process: Process): void {
        if (this.nullstrAddr === 0) {
            this.nullstrAddr = process.memory.alloc(1, "THUNK_DATA", "rw");
            Mem.writeBytes(this.nullstrAddr, new Uint8Array([0]));
        }
        if (this.nposAddr === 0) {
            this.nposAddr = process.memory.alloc(4, "THUNK_DATA", "rw");
            Mem.writeUint32(this.nposAddr, 0xffffffff);
        }
        // Shared "unshared" refcount cell for _Refcnt(_Ptr) — our basic_string never shares a
        // buffer across instances (every ctor/assign does a real copy), so it always reads 1.
        if (this.refcntAddr === 0) {
            this.refcntAddr = process.memory.alloc(2, "THUNK_DATA", "rw");
            Mem.writeUint16(this.refcntAddr, 1);
        }
        if (this.logicErrorVtableAddr === 0) {
            const tg = process.thunkGenerator;
            const retStubAddr = process.memory.alloc(1, "THUNK_CODE", "rx");
            Mem.writeBytes(retStubAddr, new Uint8Array([0xc3]));

            const outOfRangeVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(outOfRangeVtableAddr + 0, 0);
            Mem.writeUint32(outOfRangeVtableAddr + 4, retStubAddr);
            Mem.writeUint32(outOfRangeVtableAddr + 8, retStubAddr);
            Mem.writeUint32(outOfRangeVtableAddr + 12, retStubAddr);
            tg?.registerDataExport?.(this.name, "??_7out_of_range@std@@6B@", outOfRangeVtableAddr);

            const runtimeErrorVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(runtimeErrorVtableAddr + 0, 0);
            Mem.writeUint32(runtimeErrorVtableAddr + 4, retStubAddr);
            Mem.writeUint32(runtimeErrorVtableAddr + 8, retStubAddr);
            Mem.writeUint32(runtimeErrorVtableAddr + 12, retStubAddr);
            tg?.registerDataExport?.(this.name, "??_7runtime_error@std@@6B@", runtimeErrorVtableAddr);

            // logic_error's real primary ctor needs a working what():
            // `mov eax, [ecx+4]; ret` returns the object's stored message pointer.
            const whatStubAddr = process.memory.alloc(4, "THUNK_CODE", "rx");
            Mem.writeBytes(whatStubAddr, new Uint8Array([0x8b, 0x41, 0x04, 0xc3]));

            this.logicErrorVtableAddr = process.memory.alloc(16, "THUNK_DATA", "rw");
            Mem.writeUint32(this.logicErrorVtableAddr + 0, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 4, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 8, whatStubAddr);
            Mem.writeUint32(this.logicErrorVtableAddr + 12, whatStubAddr);
            tg?.registerDataExport?.(this.name, "??_7logic_error@std@@6B@", this.logicErrorVtableAddr);
        }
    }

    private registerDataExports(process: Process): void {
        const tg = process.thunkGenerator;
        tg?.registerDataExport?.(this.name, `?npos@${BS}@@2IB`, this.nposAddr);
        tg?.registerDataExport?.(this.name, `?_C@?1??_Nullstr@${BS}@@CAPBDXZ@4DB`, this.nullstrAddr);
    }

    reregisterExports(process: Process): void {
        this.process = process;
        this.nullstrAddr = 0;
        this.nposAddr = 0;
        this.refcntAddr = 0;
        this.logicErrorVtableAddr = 0;
        this.ensureRuntimeStorage(process);
        this.registerDataExports(process);
    }

    initialize(process: Process): void {
        this.process = process;
        const msvcrt = this.msvcrt;
        this.heap = {
            alloc: (n) => {
                const fn = msvcrt.exports["malloc"];
                return (fn?.(null as any, null as any, [n >>> 0]) ?? 0) as number;
            },
            free: (p) => {
                const fn = msvcrt.exports["free"];
                fn?.(null as any, null as any, [p >>> 0]);
            },
        };

        this.ensureRuntimeStorage(process);
        this.registerDataExports(process);

        const nullstr = () => this.nullstrAddr;
        const heap = this.heap;
        const EXC_OBJ_SIZE = 20;

        const copyExceptionObj = (dst: number, src: number): number => {
            for (let i = 0; i < EXC_OBJ_SIZE; i++) {
                const b = Mem.readUint8(src + i) ?? 0;
                Mem.writeBytes(dst + i, new Uint8Array([b]));
            }
            return dst;
        };

        this.exports[`?_Tidy@${BS}@@AAEX_N@Z`] = (ctx, _mem, args) => {
            vc6StringTidy(ctx.ecx >>> 0, (args[0] ?? 0) !== 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Copy@${BS}@@AAEXI@Z`] = (ctx, _mem, args) => {
            vc6StringCopy(ctx.ecx >>> 0, args[0] ?? 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Split@${BS}@@AAEXXZ`] = (ctx, _mem, _args) => {
            vc6StringSplit(ctx.ecx >>> 0, this.heap, nullstr());
            return 0;
        };

        this.exports[`?_Grow@${BS}@@AAE_NI_N@Z`] = (ctx, _mem, args) => {
            const ok = vc6StringGrow(ctx.ecx >>> 0, args[0] ?? 0, (args[1] ?? 0) !== 0, this.heap, nullstr());
            return ok ? 1 : 0;
        };

        this.exports[`?_Eos@${BS}@@AAEXI@Z`] = (ctx, _mem, args) => {
            vc6StringEos(ctx.ecx >>> 0, args[0] ?? 0, nullstr());
            return 0;
        };

        this.exports[`?erase@${BS}@@QAEAAV12@II@Z`] = (ctx, _mem, args) => {
            return vc6StringErase(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports[`?assign@${BS}@@QAEAAV12@ABV12@II@Z`] = (ctx, _mem, args) => {
            return vc6StringAssignRange(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, this.heap, nullstr());
        };

        this.exports[`?assign@${BS}@@QAEAAV12@PBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringAssignCStrCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, this.heap, nullstr());
        };

        this.exports["??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z"] = (_ctx, _mem, args) => {
            return vc6StringEqualsCStr(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports[`??0${BS}@@QAE@XZ`] = (ctx, _mem, _args) => {
            return vc6StringCtorCStr(ctx.ecx >>> 0, 0, heap, nullstr());
        };

        this.exports[`??0${BS}@@QAE@PBDABV?$allocator@D@1@@Z`] = (ctx, _mem, args) => {
            return vc6StringCtorCStr(ctx.ecx >>> 0, args[0] ?? 0, heap, nullstr());
        };

        this.exports[`??0${BS}@@QAE@ABV01@@Z`] = (ctx, _mem, args) => {
            return vc6StringCopyCtor(ctx.ecx >>> 0, args[0] ?? 0, heap, nullstr());
        };

        this.exports[`??1${BS}@@QAE@XZ`] = (ctx, _mem, _args) => {
            vc6StringTidy(ctx.ecx >>> 0, true, heap, nullstr());
            return 0;
        };

        this.exports[`??_F${BS}@@QAEXXZ`] = (ctx, _mem, _args) => {
            vc6StringTidy(ctx.ecx >>> 0, true, heap, nullstr());
            return 0;
        };

        this.exports[`?_Freeze@${BS}@@AAEXXZ`] = (_ctx, _mem, _args) => 0;

        // Private COW helper: real VC6 STL stores the share count as the u16 just before the
        // data buffer. We never share buffers (every op does a real copy), so always report 1.
        this.exports[`?_Refcnt@${BS}@@AAEAAEPBD@Z`] = (_ctx, _mem, _args) => {
            return this.refcntAddr;
        };

        this.exports[`?c_str@${BS}@@QBEPBDXZ`] = (ctx, _mem, _args) => {
            return vc6StringCStr(ctx.ecx >>> 0, nullstr());
        };

        this.exports[`?max_size@${BS}@@QBEIXZ`] = (_ctx, _mem, _args) => 0x7fffffff;

        this.exports[`?find@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFind(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?find_first_of@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFindFirstOf(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?find_last_of@${BS}@@QBEIPBDII@Z`] = (ctx, _mem, args) => {
            return vc6StringFindLastOf(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, nullstr());
        };

        this.exports[`?insert@${BS}@@QAEAAV12@IPBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringInsert(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
        };

        this.exports[`?append@${BS}@@QAEAAV12@PBDI@Z`] = (ctx, _mem, args) => {
            return vc6StringAppendCStrCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, heap, nullstr());
        };

        this.exports[`?append@${BS}@@QAEAAV12@ID@Z`] = (ctx, _mem, args) => {
            return vc6StringAppendCharCount(ctx.ecx >>> 0, args[0] ?? 0, args[1] ?? 0, heap, nullstr());
        };

        this.exports["??8std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringEquals(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        this.exports["??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringEquals(args[0] ?? 0, args[1] ?? 0, nullstr()) ? 0 : 1;
        };

        this.exports["??9std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@PBD@Z"] = (_ctx, _mem, args) => {
            return vc6StringEqualsCStr(args[0] ?? 0, args[1] ?? 0, nullstr()) ? 0 : 1;
        };

        this.exports["??Mstd@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] = (_ctx, _mem, args) => {
            return vc6StringLess(args[0] ?? 0, args[1] ?? 0, nullstr());
        };

        const opPlus = (_ctx: any, _mem: any, args: number[]) => {
            const dst = args[0] ?? 0;
            vc6StringConcat(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };
        this.exports[`??Hstd@@YA?AV${BS}@@ABV10@0@Z`] = opPlus;
        this.exports[`??Hstd@@YA?AV${BS0}@ABV10@0@Z`] = opPlus;

        this.exports[`??Hstd@@YA?AV${BS0}@PBDABV10@@Z`] = (_ctx, _mem, args) => {
            const dst = args[0] ?? 0;
            vc6StringConcatCStrLeft(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };

        this.exports[`??Hstd@@YA?AV${BS0}@ABV10@PBD@Z`] = (_ctx, _mem, args) => {
            const dst = args[0] ?? 0;
            vc6StringConcatCStrRight(dst, args[1] ?? 0, args[2] ?? 0, heap, nullstr());
            return dst;
        };

        this.exports["??0out_of_range@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        this.exports["??0runtime_error@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        this.exports["??0logic_error@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            return copyExceptionObj(ctx.ecx >>> 0, args[0] ?? 0);
        };

        // logic_error(const std::string& _Message) — the primary ctor used at `throw` sites.
        // Deep-copies the message (the guest string is a temporary that dies after the throw
        // statement) and sets up a real vtable so a later `.what()` returns the stored pointer.
        this.exports["??0logic_error@std@@QAE@ABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@1@@Z"] =
            (ctx, _mem, args) => {
                const obj = ctx.ecx >>> 0;
                const cstr = vc6StringCStr(args[0] ?? 0, nullstr());
                let len = 0;
                while ((Mem.readUint8(cstr + len) ?? 0) !== 0 && len < 0x10000) len++;
                const msgAddr = heap.alloc(len + 1);
                for (let i = 0; i <= len; i++) {
                    Mem.writeUint8(msgAddr + i, Mem.readUint8(cstr + i) ?? 0);
                }
                Mem.writeUint32(obj + 0, this.logicErrorVtableAddr);
                Mem.writeUint32(obj + 4, msgAddr);
                Mem.writeUint32(obj + 8, 1); // _Dofree
                return obj;
            };

        this.exports["??1out_of_range@std@@UAE@XZ"] = (_ctx, _mem, _args) => 0;
        this.exports["??1runtime_error@std@@UAE@XZ"] = (_ctx, _mem, _args) => 0;

        this.exports["??0_Lockit@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1_Lockit@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;

        // operator<<(basic_ostream&, const char*) — no real stream; chain return for iostream static init.
        this.exports["??6std@@YAAAV?$basic_ostream@DU?$char_traits@D@std@@@0@AAV10@PBD@Z"] = (_ctx, _mem, args) => {
            return args[0] ?? 0;
        };

        // ios_base::Init / std::_Winit — CRT iostream bootstrap objects; no-op in HLE.
        this.exports["??0Init@ios_base@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1Init@ios_base@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;
        this.exports["??0_Winit@std@@QAE@XZ"] = (ctx, _mem, _args) => ctx.ecx >>> 0;
        this.exports["??1_Winit@std@@QAE@XZ"] = (_ctx, _mem, _args) => 0;

        const throwRuntimeError = (label: string): number => {
            Logger.warn(LogCategory.SYSTEM, `msvcp60:${label} — terminating`);
            const term = msvcrt.exports["abort"];
            term?.(null as any, null as any, []);
            return 0;
        };

        this.exports["?_Xlen@std@@YAXXZ"] = () => throwRuntimeError("_Xlen");
        this.exports["?_Xran@std@@YAXXZ"] = () => throwRuntimeError("_Xran");

        Logger.log(LogCategory.SYSTEM,
            `msvcp60: initialized (_Nullstr=0x${this.nullstrAddr.toString(16)}, npos=0x${this.nposAddr.toString(16)})`);
    }
}
