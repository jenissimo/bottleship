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
import type { StubAllocator } from '../thunking/thunk-memory-manager';

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

export interface NativeSplice {
    name: string;
    toolchain: string;
    body: Uint8Array;
    mask: Uint8Array;
    same: readonly number[];
    offset: number;
    /** Original epilogue reached after a successful TLS operation. */
    continuation: number;
}

export const NATIVE_SPLICES: readonly NativeSplice[] = [
    {
        name: '_Unwind_SjLj_Register', toolchain: 'mingw-gcc3', same: [11, 59, 77, 121], offset: 0x58,
        continuation: 0x2c,
        body: hex('5589e557565383ec0c8b15000000008b7d0885d2741e8b422c85c078298b722c85f675348b42288907897a28'
            + '8d65f45b5e5f5dc3e8000000008b15000000008b422c85c079d7e8000000008b15000000008b722c85f674cc8b'
            + '5a30e80000000083ec0c89c653e80000000089c356e800000000891f893c24a1000000008b583053e800000000'
            + '5a85c05975a08d65f45b5e5f5de900000000'),
        mask: hex('ffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
            + 'ffffffffffffffff00000000ffff00000000ffffffffffffffff00000000ffff00000000ffffffffffffffffff'
            + 'ffff00000000ffffffffffffff00000000ffffffff00000000ffffffffffff00000000ffffffffff00000000ff'
            + 'ffffffffffffffffffffffffff00000000'),
    },
    {
        name: '_Unwind_SjLj_Unregister', toolchain: 'mingw-gcc3', same: [11, 54, 71], offset: 0x52,
        continuation: 0x24,
        body: hex('5589e553518b45088b18a10000000085c0741d8b502c85d278278b482c85c975318958288b5dfcc9c38db426'
            + '00000000e800000000a1000000008b502c85d279d9e800000000a1000000008b482c85c974cf5252538b583053'
            + 'e8000000005a85c05975c08b5dfcc9e900000000'),
        mask: hex('ffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
            + 'ffffffffff00000000ff00000000ffffffffffffffff00000000ff00000000ffffffffffffffffffffffffffff'
            + 'ff00000000ffffffffffffffffffffff00000000'),
    },
];

export function nativeSplicesEnabled(): boolean {
    return (globalThis as { __noNativeSplices?: boolean }).__noNativeSplices !== true;
}

const u32At = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

export function findNativeSplices(
    mem: Uint8Array, module: LoadedPEModule, splices: readonly NativeSplice[] = NATIVE_SPLICES,
): Array<NativeLeafSite & { splice: NativeSplice }> {
    const out: Array<NativeLeafSite & { splice: NativeSplice }> = [];
    const imageEnd = Math.min(module.baseAddress + module.size, mem.length);
    for (const s of module.sections ?? []) {
        if ((s.characteristics & (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)) === 0) continue;
        const start = module.baseAddress + s.virtualAddress;
        const end = Math.min(start + s.virtualSize, imageEnd);
        if (end <= start) continue;
        const sec = mem.subarray(start, end);
        for (const splice of splices) {
            const { body, mask, same } = splice;
            const n = body.length, b0 = body[0]!, b1 = body[1]!, b2 = body[2]!;
            for (let i = sec.indexOf(b0); i !== -1 && i + n <= sec.length; i = sec.indexOf(b0, i + 1)) {
                if (sec[i + 1] !== b1 || sec[i + 2] !== b2) continue;
                let k = 3;
                while (k < n && (sec[i + k]! & mask[k]!) === body[k]) k++;
                if (k !== n) continue;
                const shared = u32At(sec, i + same[0]!);
                if (!same.every(o => u32At(sec, i + o) === shared)) continue;
                out.push({ module: module.name, name: splice.name, crt: splice.toolchain, address: start + i, splice });
            }
        }
    }
    return out;
}

/**
 * The original TLS block is too small for native inline/expansion selection.
 * Publish its JMP only after the allocator-owned trampoline is completely written.
 * Missing expansion or invalid index returns to the original API path (lazy allocation).
 */
export function applyNativeSplices(mem: Uint8Array, module: LoadedPEModule, allocator?: StubAllocator): NativeLeafSite[] {
    const replaced: NativeLeafSite[] = [];
    if (!nativeSplicesEnabled() || !allocator) return replaced;
    for (const { splice, ...site } of findNativeSplices(mem, module)) {
        const register = splice.name === '_Unwind_SjLj_Register';
        const patch = site.address + splice.offset;
        const bytes: number[] = [];
        const e = (...b: number[]) => bytes.push(...b);
        const u = (v: number) => { for (let i = 0; i < 4; i++) bytes.push((v >>> (i * 8)) & 255); };
        const jumps: Array<{ at: number; target: number }> = [];
        const branch = (op: number[], target = -1) => { e(...op); const at = bytes.length; u(0); if (target >= 0) jumps.push({ at, target }); return at; };
        const bind = (at: number) => { const d = bytes.length - at - 4; for (let i=0;i<4;i++) bytes[at+i]=(d >>> (i*8))&255; };
        // EDX (Register) / EAX (Unregister) holds libgcc's shared state pointer.
        e(0x8b, register ? 0x4a : 0x48, 0x30); // ecx = dynamic TLS index
        e(0x81, 0xf9); u(1088);
        const invalid = branch([0x0f, 0x83]);
        e(0x83, 0xf9, 64);
        const expansion = branch([0x0f, 0x83]);
        e(0x64, 0xa1); u(0x18); // native TEB Self
        e(0x05); u(0xe10);
        const ready = branch([0xe9]);
        bind(expansion);
        e(0x64, 0xa1); u(0xf94);
        e(0x85, 0xc0);
        const absent = branch([0x0f, 0x84]);
        e(0x83, 0xe9, 64);
        bind(ready);
        if (register) e(0x8b, 0x14, 0x88, 0x89, 0x17, 0x89, 0x3c, 0x88);
        else e(0x89, 0x1c, 0x88);
        branch([0xe9], site.address + splice.continuation);
        bind(invalid); bind(absent);
        // Restore the only original register clobbered by the selector, and replay
        // whole displaced instructions. Remaining original bytes are untouched.
        if (register) {
            e(0x8b, 0x5a, 0x30); // original mov ebx,[edx+30h]
            const callTarget = patch + 8 + new DataView(mem.buffer, mem.byteOffset, mem.byteLength).getInt32(patch + 4, true);
            branch([0xe8], callTarget); // original GetLastError
            branch([0xe9], patch + 8);
        } else {
            // The selector overwrote EAX=state; its stable relocated global supplies it.
            e(0xa1); u(u32At(mem, site.address + splice.same[0]!));
            e(0x52, 0x52, 0x53, 0x8b, 0x58, 0x30);
            branch([0xe9], patch + 6);
        }
        let trampoline: number;
        try {
            trampoline = allocator.alloc(bytes.length, 'THUNK_CODE', 'rx');
            if (!trampoline || trampoline + bytes.length > mem.length) continue;
            const code = Uint8Array.from(bytes);
            const view = new DataView(code.buffer);
            for (const j of jumps) view.setInt32(j.at, j.target - (trampoline + j.at + 4), true);
            if (!writeGuestCode(mem, code, trampoline)) continue;
        } catch {
            Logger.warn(LogCategory.SYSTEM, '[HLE-lib] native splice allocation/emission failed; original body retained');
            continue;
        }
        // Publication errors propagate: a post-write invalidator failure must not be
        // misreported as an unchanged original body.
        const jump = new Uint8Array(5); jump[0] = 0xe9;
        new DataView(jump.buffer).setInt32(1, trampoline - patch - 5, true);
        if (!writeGuestCode(mem, jump, patch)) continue;
        replaced.push(site);
        Logger.log(LogCategory.SYSTEM,
            `[HLE-lib] native splice ${site.crt} ${site.name} @ ${site.module}+0x${(site.address - module.baseAddress).toString(16)} applied`);
    }
    return replaced;
}
