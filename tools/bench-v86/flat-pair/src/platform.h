// flat-pair platform contract: the ONLY thing that differs between the arms.
//   bs_in()    next input word from the host (config)
//   bs_out(v)  a result word to the host (checksums)
//   bs_mark(i) a phase boundary; the host timestamps it
#pragma once
typedef unsigned int u32;
#if defined(_MSC_VER) && !defined(__clang__)
#define NOINLINE __declspec(noinline)
#else
#define NOINLINE __attribute__((noinline))
#endif
#ifdef __cplusplus
extern "C" {
#endif
u32 bs_in(void);
void bs_out(u32 v);
void bs_mark(u32 id);
void bs_main(void);
void wl_setup(void);
void wl_reset(u32 seed);
u32 wl_run(u32 seed, u32 steps);
u32 wl_hash(void);
#ifdef __cplusplus
}
#endif
