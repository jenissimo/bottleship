// Freestanding x86 platform for the v86 arm: no CRT, no imports, no syscalls.
// The host talks to the guest through three I/O ports (see run-v86.mjs).
// BS_HAVE_LIBC: the Lua workload brings its own mini libc (src-lua/minilibc.c) and needs the
// x87 CRT conversion helper and 53-bit x87 precision.
#include "platform.h"
#ifdef BS_HAVE_LIBC
extern "C" { void __outdword(unsigned short, unsigned long); unsigned long __indword(unsigned short); void __halt(void); }
#pragma intrinsic(__outdword, __indword, __halt)
#else
#include <intrin.h>
#endif

extern "C" int _fltused = 0;

u32 bs_in(void) { return (u32)__indword(0x888A); }
void bs_out(u32 v) { __outdword(0x8889, v); }
void bs_mark(u32 id) { __outdword(0x8888, id); }

#ifndef BS_HAVE_LIBC
// The compiler may turn loops into these calls; there is no CRT to provide them.
extern "C" void* memset(void* d, int c, size_t n);
extern "C" void* memcpy(void* d, const void* s, size_t n);
#pragma function(memset, memcpy)
extern "C" void* memset(void* d, int c, size_t n) {
    unsigned char* p = (unsigned char*)d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}
extern "C" void* memcpy(void* d, const void* s, size_t n) {
    unsigned char* p = (unsigned char*)d;
    const unsigned char* q = (const unsigned char*)s;
    while (n--) *p++ = *q++;
    return d;
}
#else
// MSVC /arch:IA32 converts double -> integer through this CRT helper (value in ST0, result in
// EDX:EAX, truncating). Without a CRT it is ours.
extern "C" __declspec(naked) void _ftol2(void) {
    __asm {
        push ebp
        mov ebp, esp
        sub esp, 12
        fnstcw word ptr [ebp - 2]
        mov ax, word ptr [ebp - 2]
        or ax, 0C00h
        mov word ptr [ebp - 4], ax
        fldcw word ptr [ebp - 4]
        fistp qword ptr [ebp - 12]
        fldcw word ptr [ebp - 2]
        mov eax, dword ptr [ebp - 12]
        mov edx, dword ptr [ebp - 8]
        leave
        ret
    }
}
extern "C" __declspec(naked) void _ftol2_sse(void) { __asm jmp _ftol2 }
#endif

// PE entry point; the multiboot stub (run-v86.mjs) calls it with paging on and a stack.
extern "C" void bs_entry(void) {
#ifdef BS_HAVE_LIBC
    // x87 precision = 53 bits, as the Windows CRT sets it for every real program: x87 double
    // arithmetic then rounds like IEEE double, which is what the Wasm arm computes.
    unsigned short cw = 0x027F;
    __asm fldcw cw
#endif
    bs_main();
    for (;;) __halt();
}
