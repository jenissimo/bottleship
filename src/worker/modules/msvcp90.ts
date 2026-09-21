/**
 * MSVCP90 — MSVC 2008 C++ standard library (minimal HLE for SS2).
 * Implements std::basic_string<char> and std::allocator<char> exports.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Msvcrt } from "./msvcrt";
import {
    CppStringHeap,
    stringAppendCStr,
    stringAssignCStr,
    stringBegin,
    stringCompareLess,
    stringCopyConstruct,
    stringDestroy,
    stringEnd,
    stringInitEmpty,
    stringInitFromCStr,
    writeStringIterator,
} from "./crt-cppstring";

export class Msvcp90 implements IModule {
    name = "msvcp90";
    exports: Record<string, ThunkImplementation> = {};

    private heap!: CppStringHeap;
    private ymathAddr = 0;
    private msvcrt!: Msvcrt;

    setMsvcrt(msvcrt: Msvcrt): void {
        this.msvcrt = msvcrt;
    }

    initialize(_process: Process): void {
        this.registerYmathConstants(_process);
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

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ"] = (ctx, _mem, _args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringInitEmpty(thisPtr);
            return thisPtr;
        };

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringInitFromCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@ABV01@@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringCopyConstruct(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??1?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ"] = (ctx, _mem, _args) => {
            stringDestroy(ctx.ecx >>> 0, this.heap);
            return 0;
        };

        this.exports["??4?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringAssignCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["??Y?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z"] = (ctx, _mem, args) => {
            const thisPtr = ctx.ecx >>> 0;
            stringAppendCStr(thisPtr, args[0] ?? 0, this.heap);
            return thisPtr;
        };

        this.exports["?begin@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ"] = (ctx, _mem, args) => {
            return writeStringIterator(args[0] ?? 0, stringBegin(ctx.ecx >>> 0));
        };

        this.exports["?end@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ"] = (ctx, _mem, args) => {
            return writeStringIterator(args[0] ?? 0, stringEnd(ctx.ecx >>> 0));
        };

        this.exports["?allocate@?$allocator@D@std@@QAEPADI@Z"] = (_ctx, _mem, args) => {
            return this.heap.alloc(args[0] ?? 0);
        };

        this.exports["?deallocate@?$allocator@D@std@@QAEXPADI@Z"] = (_ctx, _mem, args) => {
            this.heap.free(args[0] ?? 0);
            return 0;
        };

        this.exports["??$?MDU?$char_traits@D@std@@V?$allocator@D@1@@std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z"] =
            (_ctx, _mem, args) => stringCompareLess(args[0] ?? 0, args[1] ?? 0);
    }

    reregisterExports(process: Process): void {
        this.registerYmathConstants(process);
    }

    /**
     * <ymath.h>'s IEEE constants. They are DATA, not functions: the importer dereferences
     * the address to read the value, so a thunk stub there would hand it the first bytes of
     * a stub body as a float. `_FInf` is the one a 2005-era engine pulls in for its
     * numeric_limits<float>::infinity(), which alone fails the whole image's import bind.
     */
    private registerYmathConstants(process: Process): void {
        const tg = process.thunkGenerator;
        if (!tg?.registerDataExport) return;

        const floats: Array<[string, number]> = [
            ["_FInf", Number.POSITIVE_INFINITY],
            ["_FNan", Number.NaN],
            ["_FSnan", Number.NaN],
            ["_FDenorm", 1.401298464324817e-45],
        ];
        const doubles: Array<[string, number]> = [
            ["_Inf", Number.POSITIVE_INFINITY],
            ["_Hugeval", Number.POSITIVE_INFINITY],
            ["_Nan", Number.NaN],
            ["_Snan", Number.NaN],
            ["_Denorm", 5e-324],
        ];

        // Allocate once, but REGISTER every time: a thunk-generator reset clears the data
        // export table while the bytes stay where they are, so an "already allocated" early
        // return would leave the name unbound after the first reset.
        if (this.ymathAddr === 0) {
            this.ymathAddr = process.memory.alloc(floats.length * 4 + doubles.length * 8, "THUNK_DATA", "rw");
        }
        let at = this.ymathAddr;
        for (const [name, value] of floats) {
            Mem.writeFloat32(at, value);
            tg.registerDataExport(this.name, name, at);
            at += 4;
        }
        for (const [name, value] of doubles) {
            Mem.writeFloat64(at, value);
            tg.registerDataExport(this.name, name, at);
            at += 8;
        }
    }
}
