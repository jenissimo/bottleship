/* Compile as a standalone TU: inject uncertain close at the OS boundary. */
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#define REAL_CLOSE closesocket
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <unistd.h>
#define REAL_CLOSE close
#endif
#include "tcp-accept-owner.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static int fail_close, calls;
static int injected_close(tcp_accept_socket s) {
    calls++;
    if(fail_close)return -1;
    return REAL_CLOSE(s);
}
#define TCP_ACCEPT_CLOSE(s) injected_close(s)
#include "tcp-accept-owner.c"
static tcp_accept_socket connect_peer(uint16_t port) {
    tcp_accept_socket s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    struct sockaddr_in a;assert(s!=TCP_ACCEPT_INVALID);memset(&a,0,sizeof(a));
    a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(0x7f000001u);a.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&a,sizeof(a))==0);return s;
}
static void ready(tcp_accept_socket s) {
    fd_set set;struct timeval t={2,0};FD_ZERO(&set);FD_SET(s,&set);
#ifdef _WIN32
    assert(select(0,&set,NULL,NULL,&t)>0);
#else
    assert(s<FD_SETSIZE);assert(select(s+1,&set,NULL,NULL,&t)>0);
#endif
}
int main(void) {
#ifdef _WIN32
    WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
#endif
    struct tcp_accept_owner o;struct tcp_accept_outcome c;uint16_t port;
    uint32_t acl=htonl(0x7f000001u);
    assert(tcp_accept_init(&o,"127.0.0.1",0,&acl,1,1,&port));
    tcp_accept_socket peer=connect_peer(port);ready(o.listener);
    assert(tcp_accept_grant(&o,1,&c)==TCP_ACCEPT_ADMITTED);
    tcp_accept_socket owned=tcp_accept_data_socket(&o,c.child,c.permit);
    assert(owned!=TCP_ACCEPT_INVALID);fail_close=1;calls=0;
    assert(tcp_accept_close(&o,c.child,c.permit)==-1 && calls==1);
    assert(tcp_accept_data_socket(&o,c.child,c.permit)==TCP_ACCEPT_INVALID);
    assert(tcp_accept_close(&o,c.child,c.permit)==-1 && calls==1);
    assert(o.slots[0].permit==1 && o.slots[0].child==c.child);
    fail_close=0;assert(REAL_CLOSE(owned)==0);assert(tcp_accept_stop(&o)==1);REAL_CLOSE(peer);

    acl=htonl(0x7f000002u);
    assert(tcp_accept_init(&o,"127.0.0.1",0,&acl,1,1,&port));
    peer=connect_peer(port);ready(o.listener);fail_close=1;calls=0;
    assert(tcp_accept_grant(&o,2,&c)==TCP_ACCEPT_RETAINED && calls==1);
    owned=o.slots[0].socket;
    assert(tcp_accept_data_socket(&o,c.child,c.permit)==TCP_ACCEPT_INVALID);
    assert(tcp_accept_close(&o,c.child,c.permit)==-1 && calls==1);
    assert(o.slots[0].permit==2);fail_close=0;
    assert(REAL_CLOSE(owned)==0);assert(tcp_accept_stop(&o)==1);REAL_CLOSE(peer);
#ifdef _WIN32
    WSACleanup();
#endif
    puts("tcp accept close faults: ok");return 0;
}
