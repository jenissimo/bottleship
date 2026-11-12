// Native host platform (calibration arm C): the same driver/workload objects, timed with QPC.
//   flat-native.exe warm lo hi reps seed   -> one JSON line on stdout
#include "platform.h"
#include <stdio.h>
#include <stdlib.h>
#include <windows.h>

static u32 g_in[8];
static int g_inPos;
static u32 g_out[4096];
static int g_nout;
static struct { u32 id; long long t; } g_marks[4096];
static int g_nmarks;

u32 bs_in(void) { return g_in[g_inPos++]; }
void bs_out(u32 v) { if (g_nout < 4096) g_out[g_nout++] = v; }
void bs_mark(u32 id) {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    if (g_nmarks < 4096) { g_marks[g_nmarks].id = id; g_marks[g_nmarks].t = t.QuadPart; g_nmarks++; }
}

int main(int argc, char** argv) {
    if (argc < 6) { fprintf(stderr, "usage: warm lo hi reps seed\n"); return 2; }
    g_in[0] = 0xF1A7u;
    for (int i = 1; i <= 5; i++) g_in[i] = (u32)strtoul(argv[i], 0, 0);
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    bs_main();
    printf("{\"freq\":%lld,\"marks\":[", f.QuadPart);
    for (int i = 0; i < g_nmarks; i++) {
        double ns = (double)g_marks[i].t * 1e9 / (double)f.QuadPart;
        printf("%s[%u,%.1f]", i ? "," : "", g_marks[i].id, ns);
    }
    printf("],\"outs\":[");
    for (int i = 0; i < g_nout; i++) printf("%s%u", i ? "," : "", g_out[i]);
    printf("]}\n");
    return 0;
}
