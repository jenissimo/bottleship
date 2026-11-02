/* Native pre-accept ownership contract; intended for a finite loopback test. */
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
#include "tcp-accept-owner.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static tcp_accept_socket peer(uint16_t port) {
    struct sockaddr_in address;tcp_accept_socket s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    assert(s!=TCP_ACCEPT_INVALID);memset(&address,0,sizeof(address));address.sin_family=AF_INET;
    address.sin_addr.s_addr=htonl(0x7f000001u);address.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&address,sizeof(address))==0);return s;
}
static int wait_readable(struct tcp_accept_owner *o) {
    /* select timeout bounds the test; it never relies on sleeps. */
    fd_set set;struct timeval timeout={2,0};int result;
#ifndef _WIN32
    if(o->listener>=FD_SETSIZE)return 0;
#endif
    FD_ZERO(&set);FD_SET(o->listener,&set);
#ifdef _WIN32
    result=select(0,&set,NULL,NULL,&timeout);
#else
    result=select(o->listener+1,&set,NULL,NULL,&timeout);
#endif
    return result>0 && tcp_accept_readable(o)==1;
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_owner owner;struct tcp_accept_outcome first,second;
    uint32_t acl=htonl(0x7f000001u);uint16_t port=0;
    assert(tcp_accept_init(&owner,"127.0.0.1",0,&acl,1,1,&port));
    assert(port!=0);assert(tcp_accept_readable(&owner)==0);
    /* An empty readiness result consumes no descriptor and returns permit. */
    assert(tcp_accept_grant(&owner,1,&first)==TCP_ACCEPT_UNUSED);
    assert(first.permit==1 && first.child==0);
    tcp_accept_socket p=peer(port);assert(wait_readable(&owner));
    assert(tcp_accept_grant(&owner,2,&first)==TCP_ACCEPT_ADMITTED);
    assert(first.permit==2 && first.child!=0 && first.peer_ipv4==acl && first.peer_port!=0);
    tcp_accept_socket q=peer(port);assert(wait_readable(&owner));
    /* No free slot: no second accept occurs, permit is immediately unused. */
    assert(tcp_accept_grant(&owner,3,&second)==TCP_ACCEPT_UNUSED);
    assert(second.permit==3 && second.child==0 && tcp_accept_readable(&owner)==1);
    assert(tcp_accept_close(&owner,first.child,3)==0);
    assert(tcp_accept_close(&owner,first.child,2)==1);
    assert(tcp_accept_close(&owner,first.child,2)==0);
    assert(tcp_accept_grant(&owner,3,&second)==TCP_ACCEPT_INVALID_INPUT);
    assert(tcp_accept_grant(&owner,4,&second)==TCP_ACCEPT_ADMITTED);
    assert(second.child!=first.child && second.permit==4);
    /* Removing listener must not close transferred child. */
    assert(tcp_accept_stop(&owner)==1);
    assert(send(q,"X",1,0)==1);
    fd_set readable;FD_ZERO(&readable);
    tcp_accept_socket accepted=TCP_ACCEPT_INVALID;
    for(unsigned i=0;i<owner.limit;i++)if(owner.slots[i].child==second.child)accepted=owner.slots[i].socket;
    assert(accepted!=TCP_ACCEPT_INVALID);
#ifndef _WIN32
    assert(accepted<FD_SETSIZE);
#endif
    FD_SET(accepted,&readable);
    struct timeval timeout={2,0};
#ifdef _WIN32
    assert(select(0,&readable,NULL,NULL,&timeout)>0);
#else
    assert(select(accepted+1,&readable,NULL,NULL,&timeout)>0);
#endif
    char b=0;assert(recv(accepted,&b,1,0)==1&&b=='X');
    assert(tcp_accept_close(&owner,second.child,4)==1);
    CLOSE_SOCKET(p);CLOSE_SOCKET(q);

    /* The ACL-rejected socket is closed before permit is returned. */
    uint32_t forbidden=htonl(0x7f000002u);
    assert(tcp_accept_init(&owner,"127.0.0.1",0,&forbidden,1,1,&port));
    p=peer(port);assert(wait_readable(&owner));
    assert(tcp_accept_grant(&owner,5,&first)==TCP_ACCEPT_REFUSED_CLOSED);
    assert(first.permit==5 && tcp_accept_close(&owner,first.child,5)==0);
    assert(tcp_accept_stop(&owner)==1);CLOSE_SOCKET(p);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept owner contract: ok");return 0;
}
