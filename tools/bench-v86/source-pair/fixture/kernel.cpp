#include "pair.h"

PairState pair_data;
PAIR_EXPORT PairState* pair_state() { return &pair_data; }
PAIR_EXPORT uint32_t pair_size() { return sizeof(PairState); }

PAIR_EXPORT void pair_init(uint32_t seed) {
    pair_data.magic = 0x50414952;
    pair_data.version = 1;
    pair_data.seed = seed;
    pair_data.operations = pair_data.phases = pair_data.services = pair_data.cursor = 0;
    pair_data.carry = seed ^ 0x9e3779b9u;
    pair_data.schedule = seed | 1u;
    uint32_t x = seed;
    for (uint32_t i = 0; i < 1024; ++i) {
        x = x * 1664525u + 1013904223u;
        pair_data.pixels[i] = x;
    }
}

// Unsigned arithmetic defines overflow identically on the PE and Wasm targets.
// Pointer dependencies and carry survive each service boundary.
extern "C" PAIR_NOINLINE void pair_pixels(uint32_t count) {
    uint32_t cursor = pair_data.cursor, carry = pair_data.carry;
    for (uint32_t i = 0; i < count; ++i) {
        const uint32_t j = cursor & 1023u;
        const uint32_t a = pair_data.pixels[j];
        const uint32_t b = pair_data.pixels[(j + 37u) & 1023u];
        const uint32_t rb = (((a & 0x00ff00ffu) * 3u + (b & 0x00ff00ffu)) >> 2) & 0x00ff00ffu;
        const uint32_t g = (((a & 0x0000ff00u) * 3u + (b & 0x0000ff00u)) >> 2) & 0x0000ff00u;
        const uint32_t value = (rb | g) ^ carry;
        pair_data.pixels[j] = value;
        carry = (carry << 5 | carry >> 27) + value;
        cursor += 17u;
        ++pair_data.operations;
    }
    pair_data.cursor = cursor;
    pair_data.carry = carry;
}

PAIR_EXPORT void pair_run(uint32_t operations, uint32_t burst, uint32_t mode, uint32_t variable) {
    if (!burst || mode > 3 || variable > 1) return;
    uint32_t remaining = operations;
    while (remaining) {
        pair_data.schedule = pair_data.schedule * 1664525u + 1013904223u;
        uint32_t n = variable ? 1u + pair_data.schedule % burst : burst;
        if (n > remaining) n = remaining;
        pair_pixels(n);
        ++pair_data.phases;
        pair_boundary(mode);
        remaining -= n;
    }
}
