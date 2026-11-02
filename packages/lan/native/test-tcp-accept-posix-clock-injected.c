/* Test-only process build: deterministic clock failure from the first turn. */
#ifndef _WIN32
#include <stdint.h>
static uint64_t fake_clock_failure(void) {return UINT64_MAX;}
#define TCP_POSIX_CLOCK() fake_clock_failure()
#include "tcp-accept-process-posix.c"
#else
int main(void){return 2;}
#endif
