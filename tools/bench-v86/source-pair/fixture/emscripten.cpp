#include <emscripten.h>
#include "pair.h"

EM_JS(void, pair_sync_service, (uint32_t mode), {
    if (mode === 1) performance.now();
    else globalThis.pairServiceCalls = (globalThis.pairServiceCalls || 0) + 1;
});
extern "C" void pair_service(uint32_t mode) {
    if (mode == 3) emscripten_sleep(1);
    else pair_sync_service(mode);
}
