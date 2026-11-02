/* Full write escrow with an actual non-reading TCP peer cannot trap STOP. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSE_SOCKET closesocket
#define BLOCKED (WSAGetLastError()==WSAEWOULDBLOCK)
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#define CLOSE_SOCKET close
#define BLOCKED (errno==EAGAIN||errno==EWOULDBLOCK)
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
static void frame(unsigned char *p,unsigned op,unsigned id,unsigned length) {
    memset(p,0,16+length);p32(p,16+length);p[4]=1;p[5]=(unsigned char)op;p32(p+8,id);p32(p+12,11);
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    for(unsigned scenario=0;scenario<3;scenario++) {
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));struct tcp_accept_framer *f=calloc(1,sizeof(*f));
    assert(a&&f);uint32_t acl=htonl(0x7f000001u);
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
    tcp_accept_socket sock=tcp_accept_data_socket(&a->owner,child,1);int small=4096;
    assert(setsockopt(sock,SOL_SOCKET,SO_SNDBUF,(const char*)&small,sizeof(small))==0);
    char data[16384];memset(data,'x',sizeof(data));int blocked=0;
    /* Bounded 64 MiB ceiling; no reads are performed on peer. */
    for(unsigned i=0;i<4096;i++) {
#ifdef MSG_NOSIGNAL
        int sent=send(sock,data,(int)sizeof(data),MSG_NOSIGNAL);
#else
        int sent=send(sock,data,(int)sizeof(data),0);
#endif
        if(sent<0){assert(BLOCKED);blocked=1;break;}assert(sent>0);
    }
    assert(blocked);
    for(unsigned i=0;i<TCP_FLOW_RECORDS;i++){
        frame(cmd,TCP_ACTOR_WRITE,i+2,21);p64(cmd+16,child);p64(cmd+24,1);p32(cmd+32,i+1);cmd[36]='y';
        assert(tcp_actor_command(a,cmd,37)==1);
    }
    unsigned char stream[37],control[32];frame(stream,TCP_ACTOR_WRITE,300,21);
    p64(stream+16,child);p64(stream+24,1);p32(stream+32,257);stream[36]='z';
    unsigned consumed=0;
    if(scenario==2) {
        assert(tcp_framer_feed(f,a,stream,8,&consumed)==1 && consumed==8);
    } else {
        assert(tcp_framer_feed(f,a,stream,37,&consumed)==0 && consumed==37);
    }
    unsigned control_length;
    if(scenario==0){frame(control,TCP_ACTOR_STOP,301,0);control_length=16;}
    else {frame(control,TCP_ACTOR_CLOSE_CHILD,301,16);p64(control+16,child);p64(control+24,1);control_length=32;}
    assert(tcp_framer_control(f,a,control,control_length,&consumed)==1 && consumed==control_length);
    r=tcp_actor_peek(a);assert(r && r->bytes[5]==(scenario==0?TCP_ACTOR_STOPPED:TCP_ACTOR_CHILD_CLOSED));
    if(scenario==0) {
        assert(a->stopped && tcp_accept_data_socket(&a->owner,child,1)!=TCP_ACCEPT_INVALID);
    } else {
        assert(tcp_accept_data_socket(&a->owner,child,1)==TCP_ACCEPT_INVALID);
        if(scenario==2) {
            assert(tcp_framer_feed(f,a,stream+8,29,&consumed)==1 && consumed==29);
        }
        assert(f->used==0);
    }
    assert(tcp_actor_abort(a)==1);
    CLOSE_SOCKET(peer);free(f);free(a);
    }
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept framer pressure: ok");return 0;
}
