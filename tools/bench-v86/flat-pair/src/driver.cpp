// flat-pair driver: identical in every arm. Protocol (marks):
//   1 setup done, 2 warm-up done, then per rep: 10 [lo] 11, 12 [hi] 13; 99 end.
// Every phase starts from wl_reset(seed), so lo and hi walk the SAME route prefix and the
// slope (t_hi - t_lo) / (n_hi - n_lo) is the cost of the extra steps alone.
#include "platform.h"

extern "C" void bs_main(void) {
    u32 magic = bs_in();
    if (magic != 0xF1A7u) { bs_out(0xBAD0BAD0u); return; }
    u32 warm = bs_in(), nlo = bs_in(), nhi = bs_in(), reps = bs_in(), seed = bs_in();
    wl_setup();
    bs_mark(1);
    for (u32 w = 0; w < warm; w++) {
        wl_reset(seed);
        u32 r = wl_run(seed, nhi);
        bs_out(r ^ wl_hash());
    }
    bs_mark(2);
    for (u32 i = 0; i < reps; i++) {
        wl_reset(seed);
        bs_mark(10);
        u32 a = wl_run(seed, nlo);
        bs_mark(11);
        bs_out(a ^ wl_hash());
        wl_reset(seed);
        bs_mark(12);
        u32 b = wl_run(seed, nhi);
        bs_mark(13);
        bs_out(b ^ wl_hash());
    }
    bs_mark(99);
}
