/* Owned Windows loopback: post overlapped receives before the urgent record. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <string.h>
struct observer {HANDLE events[2];HANDLE ready;HANDLE gate;DWORD first;};
static DWORD WINAPI observe(LPVOID arg) {
    struct observer *o=(struct observer*)arg;
    SetEvent(o->ready);
    if(o->gate&&WaitForSingleObject(o->gate,2000)!=WAIT_OBJECT_0)return 1;
    o->first=WaitForMultipleObjects(2,o->events,FALSE,2000);
    return 0;
}
static int run(int layout,int defer_observer) {
    const char *label=layout==0?"oob_last":layout==1?"oob_first":"oob_middle";
    SOCKET l=INVALID_SOCKET,p=INVALID_SOCKET,s=INVALID_SOCKET;WSAOVERLAPPED normal,urgent;
    WSAEVENT en=WSA_INVALID_EVENT,eu=WSA_INVALID_EVENT;int ok=0,recv_pending=0,oob_pending=0;
    HANDLE observer_thread=NULL;struct observer observer={{NULL,NULL},NULL,NULL,WAIT_FAILED};
    DWORD count=0,flags=0;char data[16]={0},extra[1]={0};WSABUF nbuf={sizeof(data),data},ubuf={sizeof(extra),extra};
    struct sockaddr_in addr;memset(&addr,0,sizeof(addr));addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(0x7f000001u);
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==INVALID_SOCKET)goto done;
    int len=sizeof(addr);
    if(bind(l,(struct sockaddr*)&addr,sizeof(addr))||listen(l,1)||getsockname(l,(struct sockaddr*)&addr,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==INVALID_SOCKET||connect(p,(struct sockaddr*)&addr,sizeof(addr)))goto done;
    s=accept(l,NULL,NULL);if(s==INVALID_SOCKET)goto done;
    en=WSACreateEvent();eu=WSACreateEvent();if(en==WSA_INVALID_EVENT||eu==WSA_INVALID_EVENT)goto done;
    memset(&normal,0,sizeof(normal));memset(&urgent,0,sizeof(urgent));normal.hEvent=en;urgent.hEvent=eu;
    int r=WSARecv(s,&nbuf,1,&count,&flags,&normal,NULL),err=r?WSAGetLastError():0;
    if(r&&err!=WSA_IO_PENDING)goto done;
    recv_pending=(r!=0);
    printf("layout=%s normal_post=%d error=%d\n",label,r,err);
    flags=MSG_OOB;count=0;
    r=WSARecv(s,&ubuf,1,&count,&flags,&urgent,NULL);err=r?WSAGetLastError():0;
    oob_pending=(r!=0&&err==WSA_IO_PENDING);
    printf("layout=%s oob_post=%d error=%d\n",label,r,err);
    if(oob_pending&&recv_pending) {
        observer.events[0]=en;observer.events[1]=eu;observer.ready=CreateEvent(NULL,TRUE,FALSE,NULL);
        if(!observer.ready)goto done;
        if(defer_observer){observer.gate=CreateEvent(NULL,TRUE,FALSE,NULL);if(!observer.gate)goto done;}
        observer_thread=CreateThread(NULL,0,observe,&observer,0,NULL);if(!observer_thread)goto done;
        if(WaitForSingleObject(observer.ready,2000)!=WAIT_OBJECT_0)goto done;
    }
    if(layout==1&&send(p,"!",1,MSG_OOB)!=1)goto done;
    if(layout==2) {
        if(send(p,"AB",2,0)!=2||send(p,"!",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2)goto done;
    } else if(send(p,"ABCD",4,0)!=4)goto done;
    if(layout==0&&send(p,"!",1,MSG_OOB)!=1)goto done;
    if(shutdown(p,SD_SEND))goto done;
    if(recv_pending&&WSAWaitForMultipleEvents(1,&en,TRUE,2000,FALSE)!=WSA_WAIT_EVENT_0)goto done;
    flags=0;count=0;
    r=WSAGetOverlappedResult(s,&normal,&count,FALSE,&flags);
    printf("layout=%s normal_done=%d n=%lu flags=%lu error=%d data=%.*s\n",label,r,(unsigned long)count,(unsigned long)flags,r?0:WSAGetLastError(),(int)count,data);
    if(!r)goto done;
    recv_pending=0;
    if(oob_pending) {
        if(WSAWaitForMultipleEvents(1,&eu,TRUE,2000,FALSE)!=WSA_WAIT_EVENT_0)goto done;
        flags=0;count=0;r=WSAGetOverlappedResult(s,&urgent,&count,FALSE,&flags);
        printf("layout=%s oob_done=%d n=%lu flags=%lu error=%d byte=%d\n",label,r,(unsigned long)count,(unsigned long)flags,r?0:WSAGetLastError(),(int)(unsigned char)extra[0]);
        oob_pending=0;
    }
    if(observer_thread) {
        if(observer.gate)SetEvent(observer.gate);
        if(WaitForSingleObject(observer_thread,2000)!=WAIT_OBJECT_0)goto done;
        printf("layout=%s first_observed_event=%lu\n",label,
            (unsigned long)(observer.first-WAIT_OBJECT_0));
        printf("layout=%s deferred_observer=%d\n",label,defer_observer);
    }
    ok=1;
done:
    if(s!=INVALID_SOCKET) {
        closesocket(s);
        if(recv_pending&&en!=WSA_INVALID_EVENT&&WSAWaitForMultipleEvents(1,&en,TRUE,2000,FALSE)!=WSA_WAIT_EVENT_0)ExitProcess(5);
        if(oob_pending&&eu!=WSA_INVALID_EVENT&&WSAWaitForMultipleEvents(1,&eu,TRUE,2000,FALSE)!=WSA_WAIT_EVENT_0)ExitProcess(5);
    }
    if(p!=INVALID_SOCKET)closesocket(p);
    if(l!=INVALID_SOCKET)closesocket(l);
    if(observer.gate)SetEvent(observer.gate);
    if(observer_thread){if(WaitForSingleObject(observer_thread,2000)!=WAIT_OBJECT_0)ExitProcess(5);CloseHandle(observer_thread);}
    if(observer.gate)CloseHandle(observer.gate);
    if(observer.ready)CloseHandle(observer.ready);
    if(en!=WSA_INVALID_EVENT)WSACloseEvent(en);
    if(eu!=WSA_INVALID_EVENT)WSACloseEvent(eu);
    if(!ok)fprintf(stderr,"pending oracle failed err=%d\n",WSAGetLastError());
    return ok;
}
int main(void) {
    WSADATA data;if(WSAStartup(MAKEWORD(2,2),&data))return 2;
    int ok=run(0,0)&&run(1,0)&&run(2,0)&&run(0,1)&&run(1,1)&&run(2,1);WSACleanup();return ok?0:1;
}
#else
#include <stdio.h>
int main(void){puts("Windows overlapped receive oracle skipped");return 0;}
#endif
