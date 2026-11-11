#include <stdint.h>

extern "C" __attribute__((noinline))
void stack_reference_kernel(const uint8_t* src, uint32_t stride, uint32_t* dst, uint32_t bias) {
    for (uint32_t row = 0; row < 8; ++row) {
        for (uint32_t col = 0; col < 8; ++col) {
            dst[col] = (uint32_t(src[col]) + bias) << 16;
        }
        src += stride;
        dst += 16;
    }
}
