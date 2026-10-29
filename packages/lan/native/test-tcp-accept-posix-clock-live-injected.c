/* Test-only process build: pipe fd 4 causes monotonic clock failure on demand. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <unistd.h>
#include <stdint.h>
#include <errno.h>
#include <time.h>
static uint64_t controlled_clock(void) {
    unsigned char byte;ssize_t n=read(4,&byte,1);
    if(n!= -1||!(errno==EAGAIN||errno==EWOULDBLOCK))return UINT64_MAX;
    struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t)!=0)return UINT64_MAX;
    return (uint64_t)t.tv_sec*1000u+(uint64_t)t.tv_nsec/1000000u;
}
#define TCP_POSIX_CLOCK() controlled_clock()
#include "tcp-accept-process-posix.c"
#else
int main(void){return 2;}
#endif
