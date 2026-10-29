/* Real socket checks for the framed serial core, not a process/IPC E2E test. */
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
#include "tcp-accept-actor.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static uint64_t u64(const unsigned char *p){return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32);}
static unsigned frame(unsigned char *p,unsigned op,uint32_t id,unsigned length){
    memset(p,0,TCP_ACTOR_HEADER+length);p32(p,TCP_ACTOR_HEADER+length);p[4]=1;p[5]=(unsigned char)op;
    p32(p+8,id);p32(p+12,77);return TCP_ACTOR_HEADER+length;
}
static const struct tcp_actor_event_record *event(struct tcp_accept_actor *a,unsigned type){
    const struct tcp_actor_event_record *r=tcp_actor_peek(a);
    assert(r&&r->bytes[5]==type&&u32(r->bytes)==r->length&&u32(r->bytes+12)==77);return r;
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));assert(a);
    uint32_t acl=htonl(0x7f000001u);unsigned char cmd[128];unsigned n;
    assert(tcp_actor_init(a,77,"127.0.0.1",0,&acl,1,1));
    const struct tcp_actor_event_record *r=event(a,TCP_ACTOR_READY);
    uint16_t port=(uint16_t)u32(r->bytes+16);assert(port);tcp_actor_pop(a);
    tcp_accept_socket peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=TCP_ACCEPT_INVALID);
    struct sockaddr_in name;memset(&name,0,sizeof(name));name.sin_family=AF_INET;
    name.sin_addr.s_addr=acl;name.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&name,sizeof(name))==0);
    fd_set readset;struct timeval timeout={2,0};FD_ZERO(&readset);
#ifndef _WIN32
    assert(a->owner.listener<FD_SETSIZE);
#endif
    FD_SET(a->owner.listener,&readset);
#ifdef _WIN32
    assert(select(0,&readset,NULL,NULL,&timeout)>0);
#else
    assert(select(a->owner.listener+1,&readset,NULL,NULL,&timeout)>0);
#endif
    assert(tcp_actor_poll_listener(a)==1);assert(tcp_actor_poll_listener(a)==0);
    event(a,TCP_ACTOR_NEED);tcp_actor_pop(a);
    n=frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,9);assert(tcp_actor_command(a,cmd,n)==1);
    r=event(a,TCP_ACTOR_GRANT_RESULT);assert(u32(r->bytes+16)==TCP_ACCEPT_ADMITTED);
    assert(u64(r->bytes+20)==9);uint64_t child=u64(r->bytes+28);assert(child);tcp_actor_pop(a);
    tcp_accept_socket second=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(second!=TCP_ACCEPT_INVALID);
    assert(connect(second,(struct sockaddr*)&name,sizeof(name))==0);
    assert(tcp_actor_poll_listener(a)==0);assert(tcp_actor_poll_listener(a)==0);
    for(unsigned i=0;i<TCP_FLOW_RECORDS;i++) {
        n=frame(cmd,TCP_ACTOR_WRITE,i+2,21);p64(cmd+16,child);p64(cmd+24,9);
        p32(cmd+32,i+1);cmd[36]='b';assert(tcp_actor_command(a,cmd,n)==1);
    }
    n=frame(cmd,TCP_ACTOR_WRITE,500,21);p64(cmd+16,child);p64(cmd+24,9);
    p32(cmd+32,257);cmd[36]='b';assert(tcp_actor_command(a,cmd,n)==0);
    assert(a->flows[0].count==TCP_FLOW_RECORDS);
    assert(tcp_actor_flush_child(a,child,9)==1);
    r=event(a,TCP_ACTOR_ACK);assert(u32(r->bytes+32)==1);tcp_actor_pop(a);
    assert(tcp_actor_command(a,cmd,n)==1);
    for(unsigned i=2;i<=257;i++) {
        assert(tcp_actor_flush_child(a,child,9)==1);
        r=event(a,TCP_ACTOR_ACK);assert(u32(r->bytes+32)==i);tcp_actor_pop(a);
    }
    n=frame(cmd,TCP_ACTOR_FIN,501,16);p64(cmd+16,child);p64(cmd+24,9);
    assert(tcp_actor_command(a,cmd,n)==1);assert(tcp_actor_flush_child(a,child,9)==1);
    event(a,TCP_ACTOR_FINISHED);tcp_actor_pop(a);
    n=frame(cmd,TCP_ACTOR_CLOSE_CHILD,502,16);p64(cmd+16,child);p64(cmd+24,9);
    assert(tcp_actor_command(a,cmd,n)==1);event(a,TCP_ACTOR_CHILD_CLOSED);tcp_actor_pop(a);
    assert(tcp_actor_poll_listener(a)==1);event(a,TCP_ACTOR_NEED);tcp_actor_pop(a);
    n=frame(cmd,TCP_ACTOR_GRANT,503,8);p64(cmd+16,10);assert(tcp_actor_command(a,cmd,n)==1);
    r=event(a,TCP_ACTOR_GRANT_RESULT);assert(u32(r->bytes+16)==TCP_ACCEPT_ADMITTED);
    child=u64(r->bytes+28);assert(child);tcp_actor_pop(a);
    for(unsigned i=0;i<TCP_ACTOR_NORMAL_OUTPUTS;i++) {
        n=frame(cmd,TCP_ACTOR_WRITE,i+2,21);p64(cmd+16,child);p64(cmd+24,10);
        p32(cmd+32,i+1);cmd[36]='a';assert(tcp_actor_command(a,cmd,n)==1);
        assert(tcp_actor_flush_child(a,child,10)==1);
    }
    assert(a->out_count==TCP_ACTOR_NORMAL_OUTPUTS);
    /* Reserved control slots remain available under normal output pressure. */
    n=frame(cmd,TCP_ACTOR_CLOSE_CHILD,100,16);p64(cmd+16,child);p64(cmd+24,10);
    n=frame(cmd,TCP_ACTOR_STOP,101,0);assert(tcp_actor_command(a,cmd,n)==1);
    assert(tcp_accept_data_socket(&a->owner,child,10)!=TCP_ACCEPT_INVALID);
    n=frame(cmd,TCP_ACTOR_CLOSE_CHILD,102,16);p64(cmd+16,child);p64(cmd+24,10);
    assert(tcp_actor_command(a,cmd,n)==1);
    assert(a->out_count==TCP_ACTOR_OUTPUTS);
    assert(tcp_accept_data_socket(&a->owner,child,10)==TCP_ACCEPT_INVALID);
    assert(tcp_actor_abort(a)==1);CLOSE_SOCKET(peer);CLOSE_SOCKET(second);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept actor control: ok");return 0;
}
