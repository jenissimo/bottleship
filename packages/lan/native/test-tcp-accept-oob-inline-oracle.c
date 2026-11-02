/* Finite native Windows SO_OOBINLINE/SIOCATMARK observation. */
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    WSADATA w;assert(WSAStartup(MAKEWORD(2,2),&w)==0);
    SOCKET listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(listener!=INVALID_SOCKET);
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(0x7f000001u);
    assert(bind(listener,(struct sockaddr*)&a,sizeof(a))==0);assert(listen(listener,1)==0);
    int len=sizeof(a);assert(getsockname(listener,(struct sockaddr*)&a,&len)==0);
    SOCKET peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=INVALID_SOCKET);
    assert(connect(peer,(struct sockaddr*)&a,sizeof(a))==0);
    SOCKET s=accept(listener,NULL,NULL);assert(s!=INVALID_SOCKET);int one=1;
    assert(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&one,sizeof(one))==0);
    assert(send(peer,"AB",2,0)==2);assert(send(peer,"!",1,MSG_OOB)==1);assert(send(peer,"CD",2,0)==2);
    fd_set reads;struct timeval t={2,0};FD_ZERO(&reads);FD_SET(s,&reads);assert(select(0,&reads,NULL,NULL,&t)>0);
    u_long mark=0;char buf[8]={0};assert(ioctlsocket(s,SIOCATMARK,&mark)==0);
    int n=recv(s,buf,8,MSG_PEEK);printf("before mark=%lu peek=%d data=%.*s\n",mark,n,n>0?n:0,buf);
    n=recv(s,buf,2,0);printf("prefix=%d data=%.*s\n",n,n>0?n:0,buf);assert(n==2);
    assert(ioctlsocket(s,SIOCATMARK,&mark)==0);
    n=recv(s,buf,8,MSG_PEEK);printf("after mark=%lu peek=%d data=%.*s\n",mark,n,n>0?n:0,buf);
    n=recv(s,buf,1,0);printf("next=%d data=%.*s\n",n,n>0?n:0,buf);
    assert(n==1&&buf[0]=='!');
    closesocket(s);closesocket(peer);closesocket(listener);WSACleanup();return 0;
}
#else
#include <stdio.h>
int main(void){puts("Windows oracle skipped");return 0;}
#endif
