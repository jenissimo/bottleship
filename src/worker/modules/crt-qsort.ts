/**
 * Native x86 insertion sort for CRT qsort().
 * Written to THUNK_CODE and called directly from guest code — no JS thunk overhead.
 * The comparison callback runs entirely in x86 guest space.
 *
 * cdecl: void qsort(void *base, size_t num, size_t size, int (*cmp)(const void*, const void*))
 */

import { Process } from "../core/process";
import { Logger, LogCategory } from "../core/logger";

/**
 * Shared qsort code address — allocated once per process generation and reused by
 * every CRT flavour (crtdll / msvcrt / msvcr90) so all their IAT bindings name the
 * SAME code.
 *
 * Keyed on `process.resetGeneration` because Process.reset() rewinds the THUNK_CODE
 * bump allocator: a cached pre-reset address is dangling and gets re-handed-out to an
 * unrelated emitter, so a module that re-publishes it binds the guest's IAT to a
 * foreign trampoline. Generation-keying makes the first re-registration after a reset
 * allocate fresh and every later one agree, independent of module iteration order.
 */
let sharedQsortCodeAddr = 0;
let sharedQsortGeneration = -1;

/**
 * Ensure native x86 qsort code is written to THUNK_CODE.
 * Returns the code address (idempotent within one process generation).
 */
export function ensureNativeQsort(process: Process): number {
    if (sharedQsortCodeAddr !== 0 && sharedQsortGeneration === process.resetGeneration) {
        return sharedQsortCodeAddr;
    }

    const QSORT_CODE_SIZE = 176;
    const addr = process.memory.alloc(QSORT_CODE_SIZE, "THUNK_CODE", "rx");
    if (!addr) return 0;

    const mem = process.getCurrentMemory();
    if (!mem) return 0;

    let off = addr;
    const w = (b: number) => { mem[off++] = b; };
    const w2 = (b0: number, b1: number) => { mem[off++] = b0; mem[off++] = b1; };
    const w3 = (b0: number, b1: number, b2: number) => { mem[off++] = b0; mem[off++] = b1; mem[off++] = b2; };
    const w4 = (b0: number, b1: number, b2: number, b3: number) => { mem[off++] = b0; mem[off++] = b1; mem[off++] = b2; mem[off++] = b3; };

    // --- Prologue ---
    w(0x55);                            // push ebp
    w2(0x89, 0xE5);                     // mov ebp, esp
    w3(0x83, 0xEC, 0x04);               // sub esp, 4           ; [ebp-4] = temp_buf ptr
    w(0x53);                            // push ebx
    w(0x56);                            // push esi
    w(0x57);                            // push edi

    // Allocate temp buffer on stack (size rounded up to 16)
    w3(0x8B, 0x45, 0x10);               // mov eax, [ebp+16]    ; size
    w3(0x83, 0xC0, 0x0F);               // add eax, 15
    w3(0x83, 0xE0, 0xF0);               // and eax, -16
    w2(0x29, 0xC4);                     // sub esp, eax
    w3(0x89, 0x65, 0xFC);               // mov [ebp-4], esp     ; save temp_buf

    // if (num < 2) goto done
    w4(0x83, 0x7D, 0x0C, 0x02);         // cmp dword [ebp+12], 2
    const jbDonePatch = off + 2;
    w2(0x0F, 0x82); w4(0, 0, 0, 0);     // jb done (patch later)

    // ebx = i = 1
    w(0xBB); w4(0x01, 0x00, 0x00, 0x00); // mov ebx, 1

    // --- outer: ---
    const outerOff = off;
    w3(0x3B, 0x5D, 0x0C);               // cmp ebx, [ebp+12]   ; i < num?
    const jgeDonePatch = off + 2;
    w2(0x0F, 0x8D); w4(0, 0, 0, 0);     // jge done (patch later)

    // memcpy(temp_buf, &base[i], size)
    w2(0x89, 0xD8);                     // mov eax, ebx
    w4(0x0F, 0xAF, 0x45, 0x10);         // imul eax, [ebp+16]
    w3(0x03, 0x45, 0x08);               // add eax, [ebp+8]
    w2(0x89, 0xC6);                     // mov esi, eax          ; src
    w3(0x8B, 0x7D, 0xFC);               // mov edi, [ebp-4]      ; dst = temp_buf
    w3(0x8B, 0x4D, 0x10);               // mov ecx, [ebp+16]     ; count
    w(0xFC);                             // cld
    w2(0xF3, 0xA4);                     // rep movsb

    // edx = j = i - 1
    w3(0x8D, 0x53, 0xFF);               // lea edx, [ebx-1]

    // --- inner: ---
    const innerOff = off;
    w2(0x85, 0xD2);                     // test edx, edx
    const jsInsertPatch = off + 1;
    w2(0x78, 0x00);                     // js insert (patch later)

    // cmp(&base[j], temp_buf)
    w2(0x89, 0xD0);                     // mov eax, edx
    w4(0x0F, 0xAF, 0x45, 0x10);         // imul eax, [ebp+16]
    w3(0x03, 0x45, 0x08);               // add eax, [ebp+8]
    w(0x52);                             // push edx              ; save j
    w3(0xFF, 0x75, 0xFC);               // push dword [ebp-4]    ; arg2 = temp_buf
    w(0x50);                             // push eax              ; arg1 = &base[j]
    w3(0xFF, 0x55, 0x14);               // call [ebp+20]         ; cmp()
    w3(0x83, 0xC4, 0x08);               // add esp, 8            ; cdecl cleanup
    w(0x5A);                             // pop edx               ; restore j

    w2(0x85, 0xC0);                     // test eax, eax
    const jleInsertPatch = off + 1;
    w2(0x7E, 0x00);                     // jle insert (patch later)

    // memcpy(&base[j+1], &base[j], size)
    w2(0x89, 0xD0);                     // mov eax, edx          ; j
    w4(0x0F, 0xAF, 0x45, 0x10);         // imul eax, [ebp+16]
    w3(0x03, 0x45, 0x08);               // add eax, [ebp+8]
    w2(0x89, 0xC6);                     // mov esi, eax          ; src = &base[j]
    w3(0x8D, 0x42, 0x01);               // lea eax, [edx+1]
    w4(0x0F, 0xAF, 0x45, 0x10);         // imul eax, [ebp+16]
    w3(0x03, 0x45, 0x08);               // add eax, [ebp+8]
    w2(0x89, 0xC7);                     // mov edi, eax          ; dst = &base[j+1]
    w3(0x8B, 0x4D, 0x10);               // mov ecx, [ebp+16]
    w(0xFC);                             // cld
    w2(0xF3, 0xA4);                     // rep movsb

    w(0x4A);                             // dec edx               ; j--
    const jmpInnerPatch = off + 1;
    w2(0xEB, 0x00);                     // jmp inner (patch later)

    // --- insert: ---
    const insertOff = off;
    // memcpy(&base[j+1], temp_buf, size)
    w3(0x8D, 0x42, 0x01);               // lea eax, [edx+1]
    w4(0x0F, 0xAF, 0x45, 0x10);         // imul eax, [ebp+16]
    w3(0x03, 0x45, 0x08);               // add eax, [ebp+8]
    w2(0x89, 0xC7);                     // mov edi, eax          ; dst = &base[j+1]
    w3(0x8B, 0x75, 0xFC);               // mov esi, [ebp-4]      ; src = temp_buf
    w3(0x8B, 0x4D, 0x10);               // mov ecx, [ebp+16]
    w(0xFC);                             // cld
    w2(0xF3, 0xA4);                     // rep movsb

    w(0x43);                             // inc ebx               ; i++
    const jmpOuterPatch = off + 1;
    w(0xE9); w4(0, 0, 0, 0);            // jmp outer (patch later)

    // --- done: epilogue ---
    const doneOff = off;
    w3(0x8D, 0x65, 0xF0);               // lea esp, [ebp-16]    ; restore past temp buf
    w(0x5F);                             // pop edi
    w(0x5E);                             // pop esi
    w(0x5B);                             // pop ebx
    w(0xC9);                             // leave
    w(0xC3);                             // ret

    // --- Patch jump targets ---
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    dv.setInt32(jbDonePatch, doneOff - (jbDonePatch + 4), true);
    dv.setInt32(jgeDonePatch, doneOff - (jgeDonePatch + 4), true);
    mem[jsInsertPatch] = (insertOff - (jsInsertPatch + 1)) & 0xFF;
    mem[jleInsertPatch] = (insertOff - (jleInsertPatch + 1)) & 0xFF;
    mem[jmpInnerPatch] = (innerOff - (jmpInnerPatch + 1)) & 0xFF;
    dv.setInt32(jmpOuterPatch, outerOff - (jmpOuterPatch + 4), true);

    const totalBytes = off - addr;
    Logger.log(LogCategory.SYSTEM,
        `Native qsort (insertion sort) written at 0x${addr.toString(16)} (${totalBytes} bytes)`);

    sharedQsortCodeAddr = addr;
    sharedQsortGeneration = process.resetGeneration;
    return addr;
}
