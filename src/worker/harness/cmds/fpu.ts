/**
 * x87 FPU state — the missing half of a float-returning guest function.
 *
 * A guest function that returns a float returns it in ST(0), and every existing
 * verb reads integer registers or memory only. So for `float f(...)` the harness
 * could see the inputs and never the answer, which is exactly the shape of a
 * lookup/curve/trig helper. `fpuState()` closes that: it decodes v86's F80 stack
 * plus the control and status words.
 *
 * The control word matters on its own. Its precision-control field decides
 * whether every intermediate rounds to 24, 53 or 64 mantissa bits, and a title
 * that sets PC=24 gets single-precision rounding on operations a modern
 * recreation would compute wider — a one-ULP difference per operation that then
 * compounds. Reading it is the cheapest way to know which one to reproduce.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { proc, cpu } from "../serialize";
import {
    getWasmView, getFpuControlWord, setFpuControlWord, decodeF80,
    FPU_ST_OFFSET, F80_SIZE,
} from "../../core/fpu-helper";

const PRECISION = ["single (24-bit)", "reserved", "double (53-bit)", "extended (64-bit)"];
const ROUNDING = ["nearest", "down", "up", "truncate"];

const PC_BITS: Record<string, number> = { single: 0, double: 2, extended: 3 };

export function registerFpuCommands(svc: HarnessService): void {
    /**
     * fpuPrecision(mode) — read or set the x87 precision-control field.
     *
     * CreateDevice already applies D3D's single-precision switch (see
     * `applyD3dCreateDeviceFpuMode`); this verb is the live override and the way to
     * read back what the guest is actually running under. `globalThis.__noD3dFpuSingle`
     * is the A/B lever for the CreateDevice default.
     *
     * The field is per-thread and rides the context-switch snapshot (§3.6), so a write
     * here lands on the RUNNING thread only — a value set while a different thread is
     * scheduled will not be what the code under test sees.
     */
    svc.register("fpuPrecision", (args) => {
        const c: any = cpu();
        if (!c) throw new HarnessError("no cpu", HarnessErrorCode.NO_PROCESS);
        const before = getFpuControlWord(c);
        if (before === null) throw new HarnessError("no wasm memory", HarnessErrorCode.UNSUPPORTED);
        const mode = args[0] === undefined ? null : String(args[0]);
        if (mode === null) {
            return { control_word: before, precision_control: PRECISION[(before >> 8) & 3], changed: false };
        }
        const bits = PC_BITS[mode];
        if (bits === undefined) {
            throw new HarnessError(`unknown precision mode ${mode} (single|double|extended)`,
                HarnessErrorCode.BAD_ARGS);
        }
        const after = ((before & ~0x0300) | (bits << 8)) & 0xffff;
        // Read back rather than trusting the store: this must go through WASM memory,
        // and a write that shadowed a JS property would otherwise report success while
        // the guest's arithmetic never moved.
        const readBack = setFpuControlWord(c, after);
        return {
            control_word_before: before, control_word: readBack,
            precision_control: PRECISION[bits],
            changed: readBack === after && after !== before,
            ...(readBack !== after ? { error: "control-word write did not stick" } : {}),
        };
    });

    /** fpuState() — control/status words and the eight registers in stack order. */
    svc.register("fpuState", () => {
        const p = proc();
        if (!p) throw new HarnessError("no process", HarnessErrorCode.NO_PROCESS);
        const c: any = cpu();
        if (!c) throw new HarnessError("no cpu", HarnessErrorCode.NO_PROCESS);

        // Offset 1152 is meaningful in v86's WASM linear memory only; there is no
        // second buffer worth falling back to, since decoding another one yields a
        // confident number that is noise.
        const dv = getWasmView(c);
        if (!dv) throw new HarnessError("no wasm memory", HarnessErrorCode.UNSUPPORTED);

        const control = getFpuControlWord(c) ?? 0;
        const status = c.fpu_status_word?.[0] ?? 0;
        const top = c.fpu_stack_ptr?.[0] ?? 0;
        const empty = c.fpu_stack_empty?.[0] ?? 0xff;

        const registers = [];
        for (let i = 0; i < 8; ++i) {
            const base = FPU_ST_OFFSET + i * F80_SIZE;
            const mantLo = dv.getUint32(base, true);
            const mantHi = dv.getUint32(base + 4, true);
            const signExponent = dv.getUint16(base + 8, true);
            const isEmpty = !!((empty >> i) & 1);
            // ST(i) is physical register (top + i) & 7.
            registers.push({
                physical: i,
                empty: isEmpty,
                mantissa: "0x" + (mantHi * 4294967296 + mantLo).toString(16),
                sign_exponent: signExponent,
                // An empty register holds whatever the last pop left behind.
                value: isEmpty ? null : decodeF80(mantLo, mantHi, signExponent),
            });
        }
        const stack = [];
        for (let i = 0; i < 8; ++i) stack.push(registers[(top + i) & 7]);

        return {
            control_word: control,
            precision_control: PRECISION[(control >> 8) & 3],
            rounding_control: ROUNDING[(control >> 10) & 3],
            status_word: status,
            stack_top: top,
            st: stack.map((r) => r.value),
            registers: stack,
        };
    });
}
