/* Pre-accept quota component. No runtime commands or policy bypass. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#define CLOSE_SOCKET closesocket
#define SOCKET_ERROR_CODE() WSAGetLastError()
#define WOULD_BLOCK WSAEWOULDBLOCK
#define ACCEPT_INTERRUPTED WSAEINTR
#define ACCEPT_ABORTED WSAECONNABORTED
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#define CLOSE_SOCKET close
#define SOCKET_ERROR_CODE() errno
#define WOULD_BLOCK EWOULDBLOCK
#define ACCEPT_INTERRUPTED EINTR
#define ACCEPT_ABORTED ECONNABORTED
#endif
#include "tcp-accept-owner.h"
#include <string.h>
#include <limits.h>
#ifndef TCP_ACCEPT_NATIVE
#define TCP_ACCEPT_NATIVE(s,a,n) accept(s,a,n)
#endif
#ifndef TCP_ACCEPT_CLOSE
#define TCP_ACCEPT_CLOSE(s) CLOSE_SOCKET(s)
#endif

static int socket_nonblocking(tcp_accept_socket socket) {
#ifdef _WIN32
    u_long enabled=1;return ioctlsocket(socket,FIONBIO,&enabled)==0;
#else
    int flags=fcntl(socket,F_GETFL,0);return flags>=0 && fcntl(socket,F_SETFL,flags|O_NONBLOCK)==0;
#endif
}
static int socket_no_sigpipe(tcp_accept_socket s) {
#if !defined(_WIN32) && !defined(MSG_NOSIGNAL)
#ifdef SO_NOSIGPIPE
    int yes=1;return setsockopt(s,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes))==0;
#else
    (void)s;return 0; /* No safe per-socket mechanism: fail closed. */
#endif
#else
    (void)s;return 1;
#endif
}
static int unicast(uint32_t network) {
    uint32_t host=ntohl(network);
    return (host>>24)!=0 && (host>>24)<224 && host!=0xffffffffu;
}
int tcp_accept_init(struct tcp_accept_owner *o,const char *host,uint16_t port,
                    const uint32_t *acl,unsigned acl_count,unsigned limit,uint16_t *bound_port) {
    struct sockaddr_in address;tcp_accept_socket descriptor;unsigned i,j;
#ifdef _WIN32
    int size=(int)sizeof(address);
#else
    socklen_t size=sizeof(address);
#endif
    if(!o||!host||!acl||!bound_port||!acl_count||acl_count>32||!limit||limit>TCP_ACCEPT_MAX)return 0;
    memset(o,0,sizeof(*o));o->listener=TCP_ACCEPT_INVALID;
    for(i=0;i<TCP_ACCEPT_MAX;i++)o->slots[i].socket=TCP_ACCEPT_INVALID;
    memset(&address,0,sizeof(address));address.sin_family=AF_INET;address.sin_port=htons(port);
    if(inet_pton(AF_INET,host,&address.sin_addr)!=1 ||
        (address.sin_addr.s_addr!=0 && !unicast(address.sin_addr.s_addr)))return 0;
    for(i=0;i<acl_count;i++) {
        if(!unicast(acl[i]))return 0;
        for(j=0;j<i;j++)if(acl[j]==acl[i])return 0;
    }
    descriptor=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    if(descriptor==TCP_ACCEPT_INVALID)return 0;
#ifdef _WIN32
    { int exclusive=1;
      if(setsockopt(descriptor,SOL_SOCKET,SO_EXCLUSIVEADDRUSE,(const char*)&exclusive,sizeof(exclusive))!=0){CLOSE_SOCKET(descriptor);return 0;} }
#endif
    if(!socket_nonblocking(descriptor)||bind(descriptor,(struct sockaddr*)&address,sizeof(address))!=0||
        listen(descriptor,(int)limit)!=0||getsockname(descriptor,(struct sockaddr*)&address,&size)!=0) {
        CLOSE_SOCKET(descriptor);return 0;
    }
    memcpy(o->acl,acl,acl_count*sizeof(*acl));o->acl_count=acl_count;o->limit=limit;
    o->listener=descriptor;*bound_port=ntohs(address.sin_port);return 1;
}
int tcp_accept_readable(struct tcp_accept_owner *o) {
    fd_set readable;struct timeval zero={0,0};int result;
    if(!o||o->listener_poisoned||o->listener==TCP_ACCEPT_INVALID)return -1;
#ifndef _WIN32
    if(o->listener>=FD_SETSIZE)return -1;
#endif
    FD_ZERO(&readable);FD_SET(o->listener,&readable);
#ifdef _WIN32
    result=select(0,&readable,NULL,NULL,&zero);
#else
    result=select(o->listener+1,&readable,NULL,NULL,&zero);
#endif
    return result<0?-1:result>0?1:0;
}
int tcp_accept_grant(struct tcp_accept_owner *o,uint64_t permit,struct tcp_accept_outcome *out) {
    unsigned i;struct sockaddr_in peer;tcp_accept_socket socket;int allowed=0;
#ifdef _WIN32
    int size=(int)sizeof(peer);
#else
    socklen_t size=sizeof(peer);
#endif
    if(!o||!out||o->listener_poisoned||o->listener==TCP_ACCEPT_INVALID||!permit||permit<=o->last_permit)return TCP_ACCEPT_INVALID_INPUT;
    memset(out,0,sizeof(*out));out->permit=permit;o->last_permit=permit;
    for(i=0;i<o->limit;i++)if(o->slots[i].socket==TCP_ACCEPT_INVALID)break;
    if(i==o->limit||o->next_child==UINT64_MAX)return TCP_ACCEPT_UNUSED;
    memset(&peer,0,sizeof(peer));
    socket=TCP_ACCEPT_NATIVE(o->listener,(struct sockaddr*)&peer,&size);
    if(socket==TCP_ACCEPT_INVALID) {
        int error=SOCKET_ERROR_CODE();out->native_error=error;
        if(error==WOULD_BLOCK||error==ACCEPT_INTERRUPTED||error==ACCEPT_ABORTED
#ifndef _WIN32
           ||error==EAGAIN
#endif
        )return TCP_ACCEPT_UNUSED;
        return TCP_ACCEPT_FAILED;
    }
    o->slots[i].socket=socket;o->slots[i].permit=permit;o->slots[i].child=++o->next_child;
    out->child=o->slots[i].child;out->peer_ipv4=peer.sin_addr.s_addr;out->peer_port=ntohs(peer.sin_port);
    for(unsigned n=0;n<o->acl_count;n++)if(peer.sin_addr.s_addr==o->acl[n])allowed=1;
    if(peer.sin_family!=AF_INET||!out->peer_port||!allowed||!socket_nonblocking(socket)||!socket_no_sigpipe(socket)) {
        if(TCP_ACCEPT_CLOSE(socket)!=0){o->slots[i].poisoned=1;return TCP_ACCEPT_RETAINED;}
        o->slots[i].socket=TCP_ACCEPT_INVALID;o->slots[i].child=0;o->slots[i].permit=0;
        return TCP_ACCEPT_REFUSED_CLOSED;
    }
    return TCP_ACCEPT_ADMITTED;
}
int tcp_accept_close(struct tcp_accept_owner *o,uint64_t child,uint64_t permit) {
    unsigned i;
    if(!o||!child||!permit)return 0;
    for(i=0;i<o->limit;i++)if(o->slots[i].child==child&&o->slots[i].permit==permit&&o->slots[i].socket!=TCP_ACCEPT_INVALID) {
        if(o->slots[i].poisoned)return -1;
        if(TCP_ACCEPT_CLOSE(o->slots[i].socket)!=0){o->slots[i].poisoned=1;return -1;}
        o->slots[i].socket=TCP_ACCEPT_INVALID;o->slots[i].child=0;o->slots[i].permit=0;return 1;
    }
    return 0;
}
tcp_accept_socket tcp_accept_data_socket(const struct tcp_accept_owner *o,uint64_t child,uint64_t permit) {
    if(!o||!child||!permit)return TCP_ACCEPT_INVALID;
    for(unsigned i=0;i<o->limit;i++) {
        const struct tcp_accept_slot *slot=&o->slots[i];
        if(slot->child==child&&slot->permit==permit&&!slot->poisoned)return slot->socket;
    }
    return TCP_ACCEPT_INVALID;
}
int tcp_accept_stop(struct tcp_accept_owner *o) {
    if(!o||o->listener==TCP_ACCEPT_INVALID)return 0;
    if(o->listener_poisoned)return -1;
    if(TCP_ACCEPT_CLOSE(o->listener)!=0){o->listener_poisoned=1;return -1;}
    o->listener=TCP_ACCEPT_INVALID;return 1;
}
