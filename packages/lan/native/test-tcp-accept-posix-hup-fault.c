/* Deterministic HUP + permanently blocked send; control must still progress.
 * Include process implementation with injected poll/clock/send/pipe write.
 * Link actor.c, framer.c, owner.c, flow.c, not process-posix.c separately. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <poll.h>
#include <unistd.h>
#include <stdint.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tcp-accept-framer.h"
static int sock_a,control_fd,data_fd,polls,flushes;
static uint64_t fake_clock(void){return 1000;}
static int fake_flush(struct tcp_accept_actor *a,uint64_t child,uint64_t permit) {
    (void)a;(void)child;(void)permit;flushes++;assert(flushes<=2);return 0;
}
static ssize_t fake_write(int fd,const void *buf,size_t n) {(void)fd;(void)buf;return (ssize_t)n;}
static int fake_poll(struct pollfd *fds,nfds_t count,int timeout) {
    polls++;assert(polls<=3);
    if(polls==1) {
        for(nfds_t i=0;i<count;i++)if(fds[i].fd==sock_a){fds[i].revents=POLLHUP;return 1;}
        assert(0);
    }
    if(polls==2) {
        assert(timeout>0&&timeout<=50);
        for(nfds_t i=0;i<count;i++)assert(fds[i].fd!=sock_a);
        for(nfds_t i=0;i<count;i++)if(fds[i].fd==control_fd){fds[i].revents=POLLIN;return 1;}
        assert(0);
    }
    for(nfds_t i=0;i<count;i++)if(fds[i].fd==data_fd){fds[i].revents=POLLHUP;return 1;}
    assert(0);return -1;
}
#define TCP_POSIX_CLOCK() fake_clock()
#define TCP_POSIX_FLUSH(a,c,p) fake_flush(a,c,p)
#define TCP_POSIX_WRITE(fd,b,n) fake_write(fd,b,n)
#define TCP_POSIX_POLL(f,n,t) fake_poll(f,n,t)
#define main tcp_posix_process_real_main
#include "tcp-accept-process-posix.c"
#undef main
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
int main(void) {
    int a[2],b[2],data[2],control[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,a)==0);
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,b)==0);assert(pipe(data)==0&&pipe(control)==0);
    close(data[1]);data_fd=data[0];control_fd=control[0];sock_a=a[0];
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));assert(actor&&framer);
    actor->epoch=19;actor->stopped=1;actor->owner.listener=TCP_ACCEPT_INVALID;actor->owner.limit=2;
    actor->owner.slots[0].socket=a[0];actor->owner.slots[0].child=1;actor->owner.slots[0].permit=17;
    actor->owner.slots[1].socket=b[0];actor->owner.slots[1].child=2;actor->owner.slots[1].permit=18;
    tcp_flow_init(&actor->flows[0]);tcp_flow_init(&actor->flows[1]);
    assert(tcp_flow_enqueue(&actor->flows[0],TCP_FLOW_DATA,1,"X",1));
    unsigned char frame[32]={0};p32(frame,32);frame[4]=1;frame[5]=TCP_ACTOR_CLOSE_CHILD;
    p32(frame+8,3);p32(frame+12,19);p64(frame+16,1);p64(frame+24,17);
    assert(write(control[1],frame,sizeof(frame))==(ssize_t)sizeof(frame));
    struct lane d={data[0],0,{0}},c={control[0],0,{0}};
    assert(run(&d,&c)==1);assert(polls==3&&flushes==2);
    assert(tcp_accept_data_socket(&actor->owner,1,17)==TCP_ACCEPT_INVALID);
    assert(tcp_accept_data_socket(&actor->owner,2,18)==b[0]);
    assert(send(b[1],"Z",1,0)==1);char v;assert(recv(b[0],&v,1,0)==1&&v=='Z');
    assert(tcp_actor_abort(actor));close(a[1]);close(b[1]);close(data[0]);close(control[0]);close(control[1]);
    free(framer);free(actor);puts("tcp POSIX HUP blocked-send fixture: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("POSIX HUP fixture skipped");return 0;}
#endif
