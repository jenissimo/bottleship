#include "codegen.h"

// Emscripten arm host. The kernels are shared source with the PE arm; only this entry differs,
// and it does nothing but call them, so the emitted Wasm for a kernel is comparable to the
// Wasm our JIT produces for the same kernel's x86.
extern "C" int main() { return 0; }
