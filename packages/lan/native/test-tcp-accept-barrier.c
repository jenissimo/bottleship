/* Real sequential loopback connections exercise bounded tombstone retirement. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSE_SOCKET closesocket
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <unistd.h>
#define CLOSE_SOCKET close
#endif
#include "tcp-accept-framer.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static uint64_t u64(const unsigned char *p){return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32);}
static void frame(unsigned char *p,unsigned op,unsigned id,unsigned size) {
    memset(p,0,16+size);p32(p,16+size);p[4]=1;p[5]=(unsigned char)op;p32(p+8,id);p32(p+12,19);
}
static const struct tcp_actor_event_record *expect(struct tcp_accept_actor *a,unsigned op) {
    const struct tcp_actor_event_record *r=tcp_actor_peek(a);assert(r&&r->bytes[5]==op);return r;
}
static tcp_accept_socket peer(uint16_t port) {
    tcp_accept_socket s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(s!=TCP_ACCEPT_INVALID);
    struct sockaddr_in name;memset(&name,0,sizeof(name));name.sin_family=AF_INET;
    name.sin_addr.s_addr=htonl(0x7f000001u);name.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&name,sizeof(name))==0);return s;
}
static void need(struct tcp_accept_actor *a,struct tcp_accept_framer *f) {
    fd_set set;struct timeval timeout={2,0};FD_ZERO(&set);
#ifndef _WIN32
    assert(a->owner.listener<FD_SETSIZE);
#endif
    FD_SET(a->owner.listener,&set);
#ifdef _WIN32
    assert(select(0,&set,NULL,NULL,&timeout)>0);
#else
    assert(select(a->owner.listener+1,&set,NULL,NULL,&timeout)>0);
#endif
    assert(tcp_framer_poll_listener(f,a)==1);expect(a,TCP_ACTOR_NEED);tcp_actor_pop(a);
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));struct tcp_accept_framer *f=calloc(1,sizeof(*f));assert(a&&f);
    uint32_t acl=htonl(0x7f000001u);assert(tcp_actor_init(a,19,"127.0.0.1",0,&acl,1,1));
    uint16_t port=(uint16_t)u32(expect(a,TCP_ACTOR_READY)->bytes+16);tcp_actor_pop(a);
    unsigned char cmd[64],write[37];unsigned used;uint64_t previous=0;
    for(unsigned i=1;i<=160;i++) {
        tcp_accept_socket s=peer(port);need(a,f);
        frame(cmd,TCP_ACTOR_GRANT,i,8);p64(cmd+16,i);
        assert(tcp_framer_feed(f,a,cmd,24,&used)==1&&used==24);
        const struct tcp_actor_event_record *r=expect(a,TCP_ACTOR_GRANT_RESULT);
        assert(u32(r->bytes+16)==TCP_ACCEPT_ADMITTED);uint64_t child=u64(r->bytes+28);assert(child>previous);previous=child;tcp_actor_pop(a);
        if(i==1) {
            frame(write,TCP_ACTOR_WRITE,201,21);p64(write+16,child);p64(write+24,i);p32(write+32,1);write[36]='x';
            assert(tcp_framer_feed(f,a,write,8,&used)==1&&used==8);
        }
        if(i==2) {
            frame(cmd,TCP_ACTOR_BARRIER,202,16);p64(cmd+16,child);p64(cmd+24,i);
            assert(tcp_framer_feed(f,a,cmd,32,&used)==0&&used==32);
        }
        frame(cmd,TCP_ACTOR_CLOSE_CHILD,300+i,16);p64(cmd+16,child);p64(cmd+24,i);
        assert(tcp_framer_control(f,a,cmd,32,&used)==1&&used==32);
        expect(a,TCP_ACTOR_CHILD_CLOSED);tcp_actor_pop(a);assert(f->closed_count==1);
        frame(cmd,TCP_ACTOR_CONTROL_FENCE,700+i,16);p64(cmd+16,child);p64(cmd+24,i);
        assert(tcp_framer_control(f,a,cmd,32,&used)==1);
        expect(a,TCP_ACTOR_FENCE_DONE);tcp_actor_pop(a);
        if(i==1)assert(tcp_framer_feed(f,a,write+8,29,&used)==1&&used==29);
        if(i==2)assert(tcp_framer_feed(f,a,NULL,0,&used)==1&&used==0);
        else {
            frame(cmd,TCP_ACTOR_BARRIER,500+i,16);p64(cmd+16,child);p64(cmd+24,i);
            assert(tcp_framer_feed(f,a,cmd,32,&used)==1&&used==32);
        }
        r=expect(a,TCP_ACTOR_BARRIER_DONE);
        assert(u64(r->bytes+16)==child&&u64(r->bytes+24)==i);tcp_actor_pop(a);
        assert(f->closed_count==0);CLOSE_SOCKET(s);
    }
    /* STOP after NEED races an already issued permit. It returns UNUSED and
       performs no accept; the parent can release that exact grant. */
    tcp_accept_socket s=peer(port);need(a,f);
    frame(cmd,TCP_ACTOR_STOP,900,0);assert(tcp_framer_control(f,a,cmd,16,&used)==1);
    expect(a,TCP_ACTOR_STOPPED);tcp_actor_pop(a);
    frame(cmd,TCP_ACTOR_GRANT,901,8);p64(cmd+16,161);
    assert(tcp_framer_feed(f,a,cmd,24,&used)==1);
    const struct tcp_actor_event_record *r=expect(a,TCP_ACTOR_GRANT_RESULT);
    assert(u32(r->bytes+16)==TCP_ACCEPT_UNUSED&&u64(r->bytes+20)==161&&u64(r->bytes+28)==0);
    tcp_actor_pop(a);assert(tcp_actor_abort(a)==1);CLOSE_SOCKET(s);free(f);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept barriers: ok");return 0;
}
