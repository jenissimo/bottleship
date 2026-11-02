/* Native integration oracle: echo prefix2, then MSG_OOB, then suffix2.
 * The sender writes all three without waiting. Winsock normal recv may cross an
 * urgent mark, so an unconstrained echo loop cannot preserve that stream order.
 * Later requests are urgent-only; the counters still come from native recv. */
#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET socket_t;
#define CLOSE closesocket
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <netinet/in.h>
#include <unistd.h>
#include <signal.h>
typedef int socket_t;
#define CLOSE close
#define INVALID_SOCKET (-1)
#endif
#include <stdio.h>
#include <stdlib.h>
#ifndef _WIN32
static int at_mark(socket_t s) { return sockatmark(s)==1; }
#endif
int main(void) {
#ifdef _WIN32
    WSADATA wsa;if (WSAStartup(MAKEWORD(2,2),&wsa)) return 2;
#else
    signal(SIGPIPE,SIG_IGN);
#endif
    socket_t listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    struct sockaddr_in local={0};local.sin_family=AF_INET;local.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    if (listener==INVALID_SOCKET || bind(listener,(struct sockaddr*)&local,sizeof(local)) || listen(listener,1)) return 3;
#ifdef _WIN32
    int length=sizeof(local);
#else
    socklen_t length=sizeof(local);
#endif
    if (getsockname(listener,(struct sockaddr*)&local,&length)) return 4;
    printf("%u\n",(unsigned)ntohs(local.sin_port));fflush(stdout);
    socket_t peer=accept(listener,NULL,NULL);CLOSE(listener);
    if (peer==INVALID_SOCKET) return 5;
#ifdef _WIN32
    u_long nonblocking=1;ioctlsocket(peer,FIONBIO,&nonblocking);
#endif
    int normal=0,urgent=0,byte=-1,pending=0,prefix_remaining=2;
    for (;;) {
        fd_set reads,exceptions;FD_ZERO(&reads);FD_ZERO(&exceptions);FD_SET(peer,&reads);FD_SET(peer,&exceptions);
        struct timeval timeout={15,0};
        if (select((int)peer+1,&reads,NULL,&exceptions,&timeout)<=0) break;
        if (FD_ISSET(peer,&exceptions)) pending=1;
        if (pending && !prefix_remaining
#ifndef _WIN32
            && at_mark(peer)
#endif
        ) {
            unsigned char value;
            int n=recv(peer,(char*)&value,1,MSG_OOB);
            if (n==1) { urgent++;byte=value;send(peer,(const char*)&value,1,MSG_OOB);pending=0; }
        }
        if (FD_ISSET(peer,&reads) && (prefix_remaining || urgent)) {
            char data[16384];
            int limit=prefix_remaining?prefix_remaining:(int)sizeof(data);
            int n=recv(peer,data,limit,0);
            if (!n) break;
            if (n<0) continue;
            normal+=n;if(prefix_remaining)prefix_remaining-=n;
            for (int offset=0;offset<n;) { int sent=send(peer,data+offset,n-offset,0);if(sent<=0) goto done;offset+=sent; }
        }
    }
done:
#ifdef _WIN32
    shutdown(peer,SD_SEND);
#else
    shutdown(peer,SHUT_WR);
#endif
    CLOSE(peer);
    printf("{\"normal\":%d,\"urgent\":%d,\"byte\":%d}\n",normal,urgent,byte);fflush(stdout);
    return 0;
}
