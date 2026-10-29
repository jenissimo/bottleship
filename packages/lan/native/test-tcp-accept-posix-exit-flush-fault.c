/* EXIT waits for EAGAIN and short physical writes of the final frame. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <poll.h>
#include <unistd.h>
#include <stdint.h>
#include <errno.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tcp-accept-framer.h"
static int calls,polls,fail_pipe;static unsigned written;static unsigned char captured[32];
static uint64_t fake_clock(void){return 1000;}
static ssize_t fake_write(int fd,const void *buffer,size_t n) {
    (void)fd;calls++;
    if(fail_pipe){errno=EPIPE;return -1;}
    if(calls<=2){errno=EAGAIN;return -1;}
    if(calls==3&&n>5)n=5;
    assert(written+n<=sizeof(captured));memcpy(captured+written,buffer,n);written+=(unsigned)n;
    return (ssize_t)n;
}
static int fake_poll(struct pollfd *fds,nfds_t count,int timeout) {
    (void)timeout;polls++;assert(polls==1);
    for(nfds_t i=0;i<count;i++)if(fds[i].fd==STDOUT_FILENO){fds[i].revents=POLLOUT;return 1;}
    assert(0);return -1;
}
#define TCP_POSIX_CLOCK() fake_clock()
#define TCP_POSIX_WRITE(fd,b,n) fake_write(fd,b,n)
#define TCP_POSIX_POLL(f,n,t) fake_poll(f,n,t)
#define main tcp_posix_process_real_main
#include "tcp-accept-process-posix.c"
#undef main
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
int main(void) {
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));assert(actor&&framer);
    actor->epoch=19;actor->stopped=1;actor->owner.listener=TCP_ACCEPT_INVALID;actor->owner.limit=0;
    framer->quiesced=1;
    struct lane d={-1,0,{0}},c={-1,16,{0}};
    p32(c.bytes,16);c.bytes[4]=1;c.bytes[5]=TCP_ACTOR_EXIT;p32(c.bytes+8,9);p32(c.bytes+12,19);
    assert(run(&d,&c)==0);assert(polls==1&&calls==4&&written==16);
    assert(captured[5]==TCP_ACTOR_EXITING&&captured[8]==9);
    assert(actor->out_count==0&&framer->output_offset==0);
    assert(tcp_actor_abort(actor));free(framer);free(actor);

    /* A broken stdout cannot produce a successful process outcome. */
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));assert(actor&&framer);
    actor->epoch=19;actor->stopped=1;actor->owner.listener=TCP_ACCEPT_INVALID;actor->owner.limit=0;
    framer->quiesced=1;memset(&d,0,sizeof(d));memset(&c,0,sizeof(c));d.fd=-1;c.fd=-1;c.length=16;
    p32(c.bytes,16);c.bytes[4]=1;c.bytes[5]=TCP_ACTOR_EXIT;p32(c.bytes+8,10);p32(c.bytes+12,19);
    fail_pipe=1;assert(run(&d,&c)==1&&actor->out_count==1);
    assert(tcp_actor_abort(actor));free(framer);free(actor);
    puts("tcp POSIX graceful partial stdout: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX stdout fault skipped");return 0;}
#endif
