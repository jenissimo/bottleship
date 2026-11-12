// Native host platform for the Lua workload (arm C): no CRT (the mini libc is the C library),
// kernel32 only. Same command line and JSON output as src/plat_native.cpp.
//   flat-native.exe warm lo hi reps seed
#include "platform.h"

extern "C" {
__declspec(dllimport) int __stdcall QueryPerformanceCounter(long long*);
__declspec(dllimport) int __stdcall QueryPerformanceFrequency(long long*);
__declspec(dllimport) char* __stdcall GetCommandLineA(void);
__declspec(dllimport) void* __stdcall GetStdHandle(unsigned long);
__declspec(dllimport) int __stdcall WriteFile(void*, const void*, unsigned long, unsigned long*, void*);
__declspec(dllimport) void __stdcall ExitProcess(unsigned);
int snprintf(char*, unsigned int, const char*, ...);
unsigned long strtoul(const char*, char**, int);
int _fltused = 0;
}

static u32 g_in[8];
static int g_inPos;
static u32 g_out[4096];
static int g_nout;
static u32 g_markId[4096];
static long long g_markT[4096];
static int g_nmarks;

u32 bs_in(void) { return g_in[g_inPos++]; }
void bs_out(u32 v) { if (g_nout < 4096) g_out[g_nout++] = v; }
void bs_mark(u32 id) {
    long long t;
    QueryPerformanceCounter(&t);
    if (g_nmarks < 4096) { g_markId[g_nmarks] = id; g_markT[g_nmarks] = t; g_nmarks++; }
}

#if !defined(__clang__)
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

static char g_buf[1 << 20];

extern "C" void bs_native_entry(void) {
    unsigned short cw = 0x027F;   // as the CRT would set it, and as the v86 arm does
    __asm fldcw cw
    char* p = GetCommandLineA();
    if (*p == '"') { p++; while (*p && *p != '"') p++; if (*p) p++; } else { while (*p && *p != ' ') p++; }
    g_in[0] = 0xF1A7u;
    for (int i = 1; i <= 5; i++) { while (*p == ' ') p++; g_in[i] = (u32)strtoul(p, &p, 0); }
    long long f;
    QueryPerformanceFrequency(&f);
    bs_main();
    int n = snprintf(g_buf, sizeof g_buf, "{\"freq\":%d,\"marks\":[", (int)f);
    for (int i = 0; i < g_nmarks; i++) {
        double ns = (double)g_markT[i] * (1e9 / (double)f);
        n += snprintf(g_buf + n, sizeof g_buf - n, "%s[%u,%.1f]", i ? "," : "", g_markId[i], ns);
    }
    n += snprintf(g_buf + n, sizeof g_buf - n, "],\"outs\":[");
    for (int i = 0; i < g_nout; i++) n += snprintf(g_buf + n, sizeof g_buf - n, "%s%u", i ? "," : "", g_out[i]);
    n += snprintf(g_buf + n, sizeof g_buf - n, "]}\n");
    unsigned long w;
    WriteFile(GetStdHandle((unsigned long)-11), g_buf, (unsigned long)n, &w, 0);
    ExitProcess(0);
}
