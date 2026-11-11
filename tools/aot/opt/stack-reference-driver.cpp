#include <stdint.h>

extern "C" void stack_reference_kernel(const uint8_t*, uint32_t, uint32_t*, uint32_t);

static uint8_t source_bytes[128];
static uint32_t destination_words[128];
static uint32_t completed_calls;
static uint32_t source_stride;
static uint32_t source_bias;

extern "C" {
uint8_t* reference_source() { return source_bytes; }
uint32_t* reference_destination() { return destination_words; }
uint32_t reference_calls() { return completed_calls; }

void reference_reset(uint32_t stride, uint32_t bias) {
    completed_calls = 0;
    source_stride = stride;
    source_bias = bias;
    for (uint32_t i = 0; i < 128; ++i) destination_words[i] = 0;
}

void reference_run(uint32_t count) {
    for (uint32_t i = 0; i < count; ++i) {
        stack_reference_kernel(source_bytes, source_stride, destination_words, source_bias);
        ++completed_calls;
    }
}
}
