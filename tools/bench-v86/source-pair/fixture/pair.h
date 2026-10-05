#pragma once
#include <stdint.h>

#ifdef _MSC_VER
#define PAIR_EXPORT extern "C" __declspec(dllexport)
#define PAIR_NOINLINE __declspec(noinline)
#else
#define PAIR_EXPORT extern "C" __attribute__((visibility("default")))
#define PAIR_NOINLINE __attribute__((noinline))
#endif

struct PairState {
    uint32_t magic, version, seed, operations, phases, services, cursor, carry, schedule;
    uint32_t pixels[1024];
};
extern PairState pair_data;
PAIR_EXPORT void pair_init(uint32_t seed);
PAIR_EXPORT void pair_run(uint32_t operations, uint32_t burst, uint32_t mode, uint32_t variable);
PAIR_EXPORT PairState* pair_state();
PAIR_EXPORT uint32_t pair_size();
extern "C" PAIR_NOINLINE void pair_boundary(uint32_t mode);
extern "C" void pair_service(uint32_t mode);
