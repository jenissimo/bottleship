/**
 * Statically linked CRT leaves whose whole contract is a computation on registers, replaced IN
 * PLACE by an equivalent native x86 body that v86's JIT runs faster. There is no OUT trap: the
 * replacement is ordinary guest code, for the same reason the imported forms are
 * (crt-math-stubs.ts) — a trap costs more than these functions do.
 *
 * Detection is an exact match of the WHOLE original body. These bodies hold no absolute address
 * (every branch is relative and internal), so relocation cannot change them and a full-body
 * match cannot land on unrelated code. Only the entry is a branch target from outside, so the
 * unreachable tail of the old body is left as it is.
 */

import { Logger, LogCategory } from '../logger';
import { writeGuestCode } from '../memory/guest-code';
import type { LoadedPEModule } from '../module-registry';

/**
 * __int64 _ftol(void): ST(0) truncated toward zero, popped, returned in EDX:EAX.
 *   83 EC 08   sub    esp, 8
 *   DD 0C 24   fisttp qword [esp]
 *   58         pop    eax
 *   5A         pop    edx
 *   C3         ret
 * FISTTP truncates whatever the rounding control says, which is exactly what both CRT bodies
 * compute the long way (MSVC6 swaps the control word around FISTP; MSVC7.1 rounds in the
 * current mode and corrects the result by the sign of the remainder). NaN and out-of-range
 * operands give the integer indefinite 0x8000000000000000, as FISTP does in both originals.
 */
export const FTOL_TRUNCATE_BODY = Uint8Array.of(0x83, 0xEC, 0x08, 0xDD, 0x0C, 0x24, 0x58, 0x5A, 0xC3);

export interface NativeLeaf {
    name: string;
    /** CRT the body ships in — two releases can share a name and differ in bytes. */
    crt: string;
    body: Uint8Array;
    replacement: Uint8Array;
}

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));

export const NATIVE_LEAVES: readonly NativeLeaf[] = [
    {
        name: '_ftol', crt: 'msvc6', replacement: FTOL_TRUNCATE_BODY,
        body: hex('558bec83c4f49bd97dfe9b668b45fe80cc0c668945fcd96dfcdf7df4d96dfe8b45f48b55f8c9c3'),
    },
    {
        name: '_ftol2', crt: 'msvc7.1', replacement: FTOL_TRUNCATE_BODY,
        body: hex('558bec83ec2083e4f0d9c0d9542418df7c2410df6c24108b5424188b44241085c0743cdee985d2791ed9'
            + '1c248b0c2481f10000008081c1ffffff7f83d0008b54241483d200eb2cd91c248b0c2481c1ffffff7f83d8'
            + '008b54241483da00eb148b542414f7c2ffffff7f75b8d95c2418d95c2418c9c3'),
    },
];

export interface NativeLeafSite {
    module: string;
    name: string;
    crt: string;
    address: number;
}

const IMAGE_SCN_CNT_CODE = 0x20;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

/** Every exact occurrence of a leaf body in the module's executable sections. */
export function findNativeLeaves(
    mem: Uint8Array, module: LoadedPEModule, leaves: readonly NativeLeaf[] = NATIVE_LEAVES,
): Array<NativeLeafSite & { leaf: NativeLeaf }> {
    const out: Array<NativeLeafSite & { leaf: NativeLeaf }> = [];
    const imageEnd = Math.min(module.baseAddress + module.size, mem.length);
    for (const s of module.sections ?? []) {
        if ((s.characteristics & (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)) === 0) continue;
        const start = module.baseAddress + s.virtualAddress;
        const end = Math.min(start + s.virtualSize, imageEnd);
        if (end <= start) continue;
        const sec = mem.subarray(start, end);
        for (const leaf of leaves) {
            const body = leaf.body, n = body.length, b0 = body[0]!, b1 = body[1]!, b2 = body[2]!;
            for (let i = sec.indexOf(b0); i !== -1 && i + n <= sec.length; i = sec.indexOf(b0, i + 1)) {
                if (sec[i + 1] !== b1 || sec[i + 2] !== b2) continue;
                let k = 3;
                while (k < n && sec[i + k] === body[k]) k++;
                if (k === n) out.push({ module: module.name, name: leaf.name, crt: leaf.crt, address: start + i, leaf });
            }
        }
    }
    return out;
}

/** Replace every leaf found in `module`; returns what was replaced. */
export function applyNativeLeaves(mem: Uint8Array, module: LoadedPEModule): NativeLeafSite[] {
    const replaced: NativeLeafSite[] = [];
    for (const { leaf, ...site } of findNativeLeaves(mem, module)) {
        if (!writeGuestCode(mem, leaf.replacement, site.address)) continue;
        replaced.push(site);
        Logger.log(LogCategory.SYSTEM,
            `[HLE-lib] native leaf ${site.crt} ${site.name} @ ${site.module}+0x${(site.address - module.baseAddress).toString(16)} replaced`);
    }
    return replaced;
}
