#pragma once
#include <stdint.h>

#ifdef _MSC_VER
#define CG_EXPORT extern "C" __declspec(dllexport)
#define CG_NOINLINE __declspec(noinline)
// One kernel per named code section. A PE section is SectionAlignment-aligned (4096) and the
// v86 JIT compiles/publishes per 4 KiB PHYSICAL page, so a captured module maps to exactly ONE
// kernel. Without this a page holds several functions and every per-instruction number derived
// from it describes a page, not a kernel.
#define CG_KERNEL(sec) extern "C" __declspec(code_seg(sec)) CG_NOINLINE
#define CG_SECTION(sec) __declspec(code_seg(sec)) CG_NOINLINE
#else
#define CG_EXPORT extern "C" __attribute__((visibility("default")))
#define CG_NOINLINE __attribute__((noinline))
#define CG_KERNEL(sec) extern "C" CG_NOINLINE
#define CG_SECTION(sec) CG_NOINLINE
#endif

#define CG_NODES 512
#define CG_CMDS  1024
#define CG_ROWS  256
#define CG_ROW_STRIDE 0xac     // NFSU walks arrays of 0xac-byte records
#define CG_VERTS 64

/** Mirrors the record NFSU's render walker indexes with `idx * 0xac`: a tag, two 16-bit
 *  selectors and several pointer-sized links, i.e. mixed operand sizes over one stride. */
struct CgRow {
    uint16_t tag, sel;
    uint32_t link, aux, flags;
    uint8_t  pad[CG_ROW_STRIDE - 16];
};

struct CgNode {
    uint16_t tag, sel;
    uint32_t child, sibling, row, payload;
};

struct CgCmd { uint32_t prev, next, kind, a, b, c, d, e; };

struct CgState {
    uint32_t magic, version, seed;
    uint32_t kernel, count, rounds;
    uint32_t acc, cursor, carry, visited, emitted, allocs;
    uint32_t freeHead, listHead, listTail, listCount;
    CgNode nodes[CG_NODES];
    CgCmd  cmds[CG_CMDS];
    CgRow  rows[CG_ROWS];
    uint32_t words[1024];
    // Integral values only: x87 at the OS default 53-bit precision control and Wasm f64 agree
    // exactly on integers below 2^52, so both arms stay bit-comparable while the PE arm still
    // runs the real x87 instruction path.
    double verts[CG_VERTS * 4];
    double matrix[16];
    double fsum;
};
extern CgState cg_data;
/** Start gate. The driver writes 1 straight into guest memory: a file written into the
 *  container while the guest is already running is not visible to it, and the gate exists so a
 *  runtime JIT switch can be configured before the kernel's page is ever compiled. */
extern "C" volatile uint32_t cg_go;

CG_EXPORT void cg_init(uint32_t seed);
CG_EXPORT void cg_run(uint32_t kernel, uint32_t count, uint32_t rounds);
CG_EXPORT CgState* cg_state();
CG_EXPORT uint32_t cg_size();
/** FNV-1a over the whole state: the cross-arm equality check, shared source so neither arm
 *  can define "the same result" differently. */
CG_EXPORT uint32_t cg_checksum();

CG_KERNEL(".cgk1") void cg_k1_walk(uint32_t count);
CG_KERNEL(".cgk2") void cg_k2_list(uint32_t count);
CG_KERNEL(".cgk3") void cg_k3_stride(uint32_t count);
CG_KERNEL(".cgk4") void cg_k4_indirect(uint32_t count);
CG_KERNEL(".cgk5") void cg_k5_x87(uint32_t count);
CG_KERNEL(".cgk6") void cg_k6_frame(uint32_t count);
