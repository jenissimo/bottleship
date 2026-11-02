/* Owned Windows IOCP oracle: urgent/normal completion order and bytes. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <string.h>
static int run(int layout,int staged,int oob_post_first) {
    const char *name=layout==0?"oob_first":layout==1?"oob_middle":"oob_last";
    SOCKET l=INVALID_SOCKET,p=INVALID_SOCKET,s=INVALID_SOCKET;HANDLE port=NULL;
    WSAOVERLAPPED normal,urgent;char data[16]={0},extra[1]={0};
    WSABUF nb={sizeof(data),data},ub={sizeof(extra),extra};
    DWORD n=0,flags=0;int ok=0,posted=0;
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(0x7f000001u);
    int len=sizeof(a);
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==INVALID_SOCKET)goto done;
    if(bind(l,(struct sockaddr*)&a,sizeof(a))||listen(l,1)||getsockname(l,(struct sockaddr*)&a,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==INVALID_SOCKET||connect(p,(struct sockaddr*)&a,sizeof(a)))goto done;
    s=accept(l,NULL,NULL);if(s==INVALID_SOCKET)goto done;
    port=CreateIoCompletionPort((HANDLE)s,NULL,1,1);if(!port)goto done;
    memset(&normal,0,sizeof(normal));memset(&urgent,0,sizeof(urgent));
    for(int step=0;step<2;step++) {
        int send_now=staged?(step==0):(step==1);
        if(send_now) {
            if(layout==0&&send(p,"!",1,MSG_OOB)!=1)goto done;
            if(layout==1) {
                if(send(p,"AB",2,0)!=2||send(p,"!",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2)goto done;
            } else if(send(p,"ABCD",4,0)!=4)goto done;
            if(layout==2&&send(p,"!",1,MSG_OOB)!=1)goto done;
            if(shutdown(p,SD_SEND))goto done;
            if(staged) {
                u_long available=0;
                for(int i=0;i<2000;i++){if(ioctlsocket(s,FIONREAD,&available))goto done;if(available>=4)break;Sleep(1);}
                if(available<4)goto done;
                fd_set excepts;struct timeval tv={2,0};FD_ZERO(&excepts);FD_SET(s,&excepts);
                if(select(0,NULL,NULL,&excepts,&tv)<=0)goto done;
            }
        } else {
            for(int i=0;i<2;i++) {
                int use_oob=oob_post_first?(i==0):(i==1);
                flags=use_oob?MSG_OOB:0;n=0;
                int r=WSARecv(s,use_oob?&ub:&nb,1,&n,&flags,use_oob?&urgent:&normal,NULL);
                int e=r?WSAGetLastError():0;
                if(r&&e!=WSA_IO_PENDING)goto done;
                posted++;
            }
        }
    }
    for(int i=0;i<2;i++) {
        DWORD count=0;ULONG_PTR key=0;OVERLAPPED *ov=NULL;
        BOOL result=GetQueuedCompletionStatus(port,&count,&key,&ov,2000);
        if(!ov||key!=1||(!result&&GetLastError()==WAIT_TIMEOUT))goto done;
        if(ov!=&normal&&ov!=&urgent)goto done;
        printf("layout=%s staged=%d post_oob_first=%d completion_index=%d kind=%s ok=%d bytes=%lu data=%.*s\n",
            name,staged,oob_post_first,i,ov==&normal?"normal":"oob",(int)result,(unsigned long)count,
            (int)count,ov==&normal?data:extra);
        posted--;
    }
    ok=1;
done:
    if(s!=INVALID_SOCKET)closesocket(s);
    /* Any outstanding I/O can reference stack buffers: process exit is the barrier. */
    if(posted)ExitProcess(5);
    if(p!=INVALID_SOCKET)closesocket(p);
    if(l!=INVALID_SOCKET)closesocket(l);
    if(port)CloseHandle(port);
    if(!ok)fprintf(stderr,"IOCP oracle failed error=%lu\n",(unsigned long)GetLastError());
    return ok;
}
int main(void) {
    WSADATA w;if(WSAStartup(MAKEWORD(2,2),&w))return 2;
    int ok=1;
    for(int l=0;l<3&&ok;l++)for(int staged=0;staged<2&&ok;staged++)for(int first=0;first<2&&ok;first++)ok=run(l,staged,first);
    WSACleanup();return ok?0:1;
}
#else
#include <stdio.h>
int main(void){puts("Windows IOCP oracle skipped");return 0;}
#endif
