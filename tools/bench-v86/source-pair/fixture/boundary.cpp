#include "pair.h"

// Separate translation unit and no LTO: both compilers must honor this boundary.
// Service return values are intentionally excluded from the deterministic payload.
extern "C" PAIR_NOINLINE void pair_boundary(uint32_t mode) {
    if (mode) {
        pair_service(mode);
        ++pair_data.services;
    }
    const uint32_t j = (pair_data.phases * 13u) & 1023u;
    pair_data.pixels[j] ^= pair_data.carry + pair_data.phases;
    pair_data.carry += pair_data.pixels[j];
}
