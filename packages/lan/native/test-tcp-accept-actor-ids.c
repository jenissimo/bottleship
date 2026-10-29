/* Pending IDs and IDs in undelivered ACK frames remain owned. */
#ifdef _WIN32
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
#include "tcp-accept-actor.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static uint64_t u64(const unsigned char *p){return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32);}
static void frame(unsigned char *p,unsigned op,unsigned id,unsigned length) {
    memset(p,0,16+length);p32(p,16+length);p[4]=1;p[5]=(unsigned char)op;p32(p+8,id);p32(p+12,11);
}
static void run(int after_ack) {
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));assert(a);uint32_t acl=htonl(0x7f000001u);
    assert(tcp_actor_init(a,11,"127.0.0.1",0,&acl,1,1));
    const struct tcp_actor_event_record *r=tcp_actor_peek(a);uint16_t port=(uint16_t)u32(r->bytes+16);tcp_actor_pop(a);
    tcp_accept_socket peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=TCP_ACCEPT_INVALID);
    struct sockaddr_in name;memset(&name,0,sizeof(name));name.sin_family=AF_INET;name.sin_addr.s_addr=acl;name.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&name,sizeof(name))==0);
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
    assert(tcp_actor_poll_listener(a)==1);tcp_actor_pop(a);
    unsigned char cmd[64];frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,1);
    assert(tcp_actor_command(a,cmd,24)==1);r=tcp_actor_peek(a);uint64_t child=u64(r->bytes+28);assert(child);tcp_actor_pop(a);
    frame(cmd,TCP_ACTOR_WRITE,2,21);p64(cmd+16,child);p64(cmd+24,1);p32(cmd+32,8);cmd[36]='x';
    assert(tcp_actor_command(a,cmd,37)==1);
    if(after_ack){assert(tcp_actor_flush_child(a,child,1)==1);assert(tcp_actor_peek(a)->bytes[5]==TCP_ACTOR_ACK);}
    unsigned count=a->flows[0].count,outputs=a->out_count;
    assert(tcp_actor_command(a,cmd,37)==-1);
    assert(a->flows[0].count==count&&a->out_count==outputs);
    assert(tcp_actor_abort(a)==1);CLOSE_SOCKET(peer);free(a);
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    run(0);run(1);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp actor write id ownership: ok");return 0;
}
