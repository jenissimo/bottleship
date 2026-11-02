/* Deterministic accept syscall errors; compile with actor.c and flow.c only.
 * This translation unit includes owner.c under an injected accept boundary. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSE_SOCKET closesocket
#define ERR_BLOCK WSAEWOULDBLOCK
#define ERR_INTR WSAEINTR
#define ERR_FATAL WSAEMFILE
#define ERR_ABORT WSAECONNABORTED
#define SET_ERROR(n) WSASetLastError(n)
typedef int test_socklen;
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#define CLOSE_SOCKET close
#define ERR_BLOCK EWOULDBLOCK
#define ERR_INTR EINTR
#define ERR_FATAL EMFILE
#define ERR_ABORT ECONNABORTED
#define SET_ERROR(n) (errno=(n))
typedef socklen_t test_socklen;
#endif
#include "tcp-accept-actor.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
static int injected_error;
static tcp_accept_socket fake_accept(tcp_accept_socket s,struct sockaddr *a,test_socklen *n) {
    (void)s;(void)a;(void)n;SET_ERROR(injected_error);return TCP_ACCEPT_INVALID;
}
#define TCP_ACCEPT_NATIVE(s,a,n) fake_accept(s,a,n)
#include "tcp-accept-owner.c"
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    uint32_t acl=htonl(0x7f000001u);uint16_t port;struct tcp_accept_owner o;struct tcp_accept_outcome out;
    assert(tcp_accept_init(&o,"127.0.0.1",0,&acl,1,1,&port));
    injected_error=ERR_BLOCK;assert(tcp_accept_grant(&o,1,&out)==TCP_ACCEPT_UNUSED);
    assert(out.permit==1&&out.native_error==ERR_BLOCK&&out.child==0);
    injected_error=ERR_INTR;assert(tcp_accept_grant(&o,2,&out)==TCP_ACCEPT_UNUSED);
    assert(out.permit==2&&out.native_error==ERR_INTR&&out.child==0);
    injected_error=ERR_ABORT;assert(tcp_accept_grant(&o,3,&out)==TCP_ACCEPT_UNUSED);
    assert(out.permit==3&&out.native_error==ERR_ABORT&&out.child==0);
    injected_error=ERR_FATAL;assert(tcp_accept_grant(&o,4,&out)==TCP_ACCEPT_FAILED);
    assert(out.permit==4&&out.native_error==ERR_FATAL&&out.child==0);
    assert(tcp_accept_stop(&o)==1);
    struct tcp_accept_actor *a=calloc(1,sizeof(*a));assert(a);
    assert(tcp_actor_init(a,7,"127.0.0.1",0,&acl,1,1));tcp_actor_pop(a);
    tcp_accept_socket peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=TCP_ACCEPT_INVALID);
    struct sockaddr_in name;memset(&name,0,sizeof(name));name.sin_family=AF_INET;
    name.sin_addr.s_addr=acl;name.sin_port=htons(port);
    /* actor's actual port may differ from previous listener */
#ifdef _WIN32
    int len=sizeof(name);
#else
    socklen_t len=sizeof(name);
#endif
    assert(getsockname(a->owner.listener,(struct sockaddr*)&name,&len)==0);
    name.sin_addr.s_addr=acl;assert(connect(peer,(struct sockaddr*)&name,sizeof(name))==0);
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
    unsigned char grant[24]={0};p32(grant,24);grant[4]=1;grant[5]=TCP_ACTOR_GRANT;p32(grant+8,1);p32(grant+12,7);grant[16]=4;
    assert(tcp_actor_command(a,grant,sizeof(grant))==-1);
    assert(a->fatal&&a->native_error==ERR_FATAL&&a->owner.last_permit==4);
    assert(tcp_actor_peek(a)==NULL);assert(tcp_actor_abort(a)==1);
    CLOSE_SOCKET(peer);free(a);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept native error: ok");return 0;
}
