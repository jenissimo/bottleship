/* Fault clock after HUP: run must fail promptly and caller closes owned sockets.
 * Link actor.c, framer.c, owner.c, flow.c; process source is included. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <poll.h>
#include <unistd.h>
#include <stdint.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "tcp-accept-framer.h"
static int socket_a,polls,flushes,clocks;
static uint64_t fake_clock(void){return ++clocks==1?1000:UINT64_MAX;}
static int fake_flush(struct tcp_accept_actor *a,uint64_t c,uint64_t p) {
    (void)a;(void)c;(void)p;flushes++;return 0;
}
static int fake_poll(struct pollfd *fds,nfds_t count,int timeout) {
    (void)timeout;polls++;assert(polls==1);
    for(nfds_t i=0;i<count;i++)if(fds[i].fd==socket_a){fds[i].revents=POLLHUP;return 1;}
    assert(0);return -1;
}
#define TCP_POSIX_CLOCK() fake_clock()
#define TCP_POSIX_FLUSH(a,c,p) fake_flush(a,c,p)
#define TCP_POSIX_POLL(f,n,t) fake_poll(f,n,t)
#define main tcp_posix_process_real_main
#include "tcp-accept-process-posix.c"
#undef main
int main(void) {
    int a[2],b[2],data[2],control[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,a)==0);
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,b)==0);assert(pipe(data)==0&&pipe(control)==0);
    socket_a=a[0];actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));assert(actor&&framer);
    actor->epoch=19;actor->stopped=1;actor->owner.listener=TCP_ACCEPT_INVALID;actor->owner.limit=2;
    actor->owner.slots[0].socket=a[0];actor->owner.slots[0].child=1;actor->owner.slots[0].permit=17;
    actor->owner.slots[1].socket=b[0];actor->owner.slots[1].child=2;actor->owner.slots[1].permit=18;
    tcp_flow_init(&actor->flows[0]);tcp_flow_init(&actor->flows[1]);
    assert(tcp_flow_enqueue(&actor->flows[0],TCP_FLOW_DATA,1,"X",1));
    struct lane d={data[0],0,{0}},c={control[0],0,{0}};
    assert(run(&d,&c)==1);assert(clocks==2&&polls==1&&flushes==1);
    /* Main executes abort after run failure. No release event is fabricated. */
    assert(tcp_actor_peek(actor)==NULL);assert(tcp_actor_abort(actor));
    char byte;assert(recv(a[1],&byte,1,0)==0);assert(recv(b[1],&byte,1,0)==0);
    close(a[1]);close(b[1]);close(data[0]);close(data[1]);close(control[0]);close(control[1]);
    free(framer);free(actor);puts("tcp POSIX clock failure cleanup: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX clock fault skipped");return 0;}
#endif
