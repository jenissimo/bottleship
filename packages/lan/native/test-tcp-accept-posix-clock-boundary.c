/* Retry deadlines cannot alias the clock-failure sentinel or wrap. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <poll.h>
#include <unistd.h>
#include <stdint.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
static uint64_t clock_value;static int polls,data_fd;
static uint64_t fake_clock(void){return clock_value;}
static int fake_poll(struct pollfd *fds,nfds_t count,int timeout) {
    (void)timeout;polls++;
    for(nfds_t i=0;i<count;i++)if(fds[i].fd==data_fd){fds[i].revents=POLLHUP;return 1;}
    assert(0);return -1;
}
#define TCP_POSIX_CLOCK() fake_clock()
#define TCP_POSIX_POLL(f,n,t) fake_poll(f,n,t)
#define main tcp_posix_process_real_main
#include "tcp-accept-process-posix.c"
#undef main
static void check(uint64_t value,int expected_polls) {
    int data[2],control[2];assert(pipe(data)==0&&pipe(control)==0);close(data[1]);data_fd=data[0];
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));assert(actor&&framer);
    actor->epoch=19;actor->stopped=1;actor->owner.listener=TCP_ACCEPT_INVALID;actor->owner.limit=0;
    struct lane d={data[0],0,{0}},c={control[0],0,{0}};
    clock_value=value;polls=0;assert(run(&d,&c)==1);assert(polls==expected_polls);
    assert(tcp_actor_abort(actor));close(data[0]);close(control[0]);close(control[1]);free(actor);free(framer);
}
int main(void) {
    check(UINT64_MAX,0);check(UINT64_MAX-49u,0);check(UINT64_MAX-50u,0);
    check(UINT64_MAX-51u,1);
    puts("tcp POSIX clock boundaries: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX clock boundaries skipped");return 0;}
#endif
