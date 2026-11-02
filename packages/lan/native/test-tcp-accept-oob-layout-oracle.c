/* Compare kernel-visible non-inline urgent marks on owned loopback sockets.
 * Each case is finite and reports observations, not assumed cross-OS parity. */
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET sock_t;
#define BAD INVALID_SOCKET
#define CLOSE closesocket
#define ERR() WSAGetLastError()
#define IOCTL ioctlsocket
#define SHUT_SEND SD_SEND
#else
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
typedef int sock_t;
#define BAD (-1)
#define CLOSE close
#define ERR() errno
#define IOCTL ioctl
#define SHUT_SEND SHUT_WR
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static int wait_for(sock_t s,int exception) {
    fd_set reads,ex;struct timeval deadline={2,0};
    FD_ZERO(&reads);FD_ZERO(&ex);
    if(exception)FD_SET(s,&ex);else FD_SET(s,&reads);
#ifdef _WIN32
    return select(0,exception?NULL:&reads,NULL,exception?&ex:NULL,&deadline)>0;
#else
    return select(s+1,exception?NULL:&reads,NULL,exception?&ex:NULL,&deadline)>0;
#endif
}
static int at_mark(sock_t s,unsigned long *mark) {
#ifdef _WIN32
    return IOCTL(s,SIOCATMARK,mark)==0;
#else
    int value=sockatmark(s);
    if(value<0)return 0;
    *mark=(unsigned long)value;return 1;
#endif
}
#ifdef _WIN32
static void overlapped_probe(sock_t s,const char *layout,const char *phase) {
    WSAOVERLAPPED ov;WSABUF b;DWORD n=0,flags=MSG_PEEK;
    char bytes[32]={0};
    memset(&ov,0,sizeof(ov));ov.hEvent=WSACreateEvent();if(ov.hEvent==WSA_INVALID_EVENT)ExitProcess(4);
    b.buf=bytes;b.len=(ULONG)sizeof(bytes);
    int rc=WSARecv(s,&b,1,&n,&flags,&ov,NULL),error=rc?WSAGetLastError():0;
    if(rc&&error==WSA_IO_PENDING) {
        DWORD wait=WSAWaitForMultipleEvents(1,&ov.hEvent,TRUE,2000,FALSE);
        if(wait!=WSA_WAIT_EVENT_0)ExitProcess(4);
        if(!WSAGetOverlappedResult(s,&ov,&n,FALSE,&flags)){rc=-1;error=WSAGetLastError();}else{rc=0;error=0;}
    }
    printf("layout=%s phase=%s overlapped_peek_result=%d n=%lu flags=%lu error=%d data=%.*s\n",
        layout,phase,rc,(unsigned long)n,(unsigned long)flags,error,(int)n,bytes);
    WSACloseEvent(ov.hEvent);
    memset(&ov,0,sizeof(ov));ov.hEvent=WSACreateEvent();if(ov.hEvent==WSA_INVALID_EVENT)ExitProcess(4);
    u_long mark=99;DWORD returned=0;flags=0;
    rc=WSAIoctl(s,SIOCATMARK,NULL,0,&mark,sizeof(mark),&returned,&ov,NULL);
    error=rc?WSAGetLastError():0;
    if(rc&&error==WSA_IO_PENDING) {
        DWORD wait=WSAWaitForMultipleEvents(1,&ov.hEvent,TRUE,2000,FALSE);
        if(wait!=WSA_WAIT_EVENT_0)ExitProcess(4);
        if(!WSAGetOverlappedResult(s,&ov,&returned,FALSE,&flags)){rc=-1;error=WSAGetLastError();}else{rc=0;error=0;}
    }
    printf("layout=%s phase=%s overlapped_ioctl_result=%d mark=%lu n=%lu error=%d\n",
        layout,phase,rc,mark,(unsigned long)returned,error);
    WSACloseEvent(ov.hEvent);
}
static void afd_handles_probe(sock_t s,const char *layout,const char *phase) {
    ULONG request=2;struct {HANDLE address;HANDLE connection;} info={NULL,NULL};
    OVERLAPPED ov;memset(&ov,0,sizeof(ov));ov.hEvent=CreateEvent(NULL,TRUE,FALSE,NULL);
    if(!ov.hEvent)ExitProcess(4);
    DWORD n=0,error=0;BOOL ok=DeviceIoControl((HANDLE)s,0x12037,&request,sizeof(request),&info,sizeof(info),&n,&ov);
    if(!ok) {
        error=GetLastError();
        if(error==ERROR_IO_PENDING) {
            DWORD wait=WaitForSingleObject(ov.hEvent,2000);if(wait!=WAIT_OBJECT_0)ExitProcess(4);
            ok=GetOverlappedResult((HANDLE)s,&ov,&n,FALSE);error=ok?0:GetLastError();
        }
    }
    printf("layout=%s phase=%s afd_handles_ok=%d has_connection=%d n=%lu error=%lu\n",
        layout,phase,(int)ok,info.connection!=NULL,(unsigned long)n,(unsigned long)error);
    if(ok&&info.connection) {
        DWORD handle_flags=0;BOOL valid=GetHandleInformation(info.connection,&handle_flags);
        DWORD handle_error=valid?0:GetLastError();
        printf("layout=%s phase=%s tdi_handle_valid=%d error=%lu\n",layout,phase,(int)valid,(unsigned long)handle_error);
        /* NT5 TCP_SOCKET_ATMARK through the duplicated TDI connection. */
        struct {ULONG entity,instance,info_class,info_type,id;unsigned char context[16];} request_info={0x400,0,0x200,0x300,5,{0}};
        struct {ULONG size;LONG offset;} mark={0,0};
        OVERLAPPED q;memset(&q,0,sizeof(q));q.hEvent=CreateEvent(NULL,TRUE,FALSE,NULL);
        if(!q.hEvent)ExitProcess(4);
        DWORD out=0,query_error=0;
        BOOL query_ok=DeviceIoControl(info.connection,0x120003,&request_info,sizeof(request_info),&mark,sizeof(mark),&out,&q);
        if(!query_ok) {
            query_error=GetLastError();
            if(query_error==ERROR_IO_PENDING) {
                DWORD wait=WaitForSingleObject(q.hEvent,2000);if(wait!=WAIT_OBJECT_0)ExitProcess(4);
                query_ok=GetOverlappedResult(info.connection,&q,&out,FALSE);query_error=query_ok?0:GetLastError();
            }
        }
        printf("layout=%s phase=%s tdi_atmark_ok=%d size=%lu offset=%ld n=%lu error=%lu\n",
            layout,phase,(int)query_ok,(unsigned long)mark.size,(long)mark.offset,(unsigned long)out,(unsigned long)query_error);
        CloseHandle(q.hEvent);
    }
    if(ok&&info.address)CloseHandle(info.address);
    if(ok&&info.connection)CloseHandle(info.connection);
    CloseHandle(ov.hEvent);
}
static void afd_probe(sock_t s,const char *layout,const char *phase) {
    /* NT5 AFD_QUERY_RECEIVE_INFO, METHOD_NEITHER, only on this owned socket.
     * Undocumented and observational: modern Windows may reject it. */
    struct {ULONG normal;ULONG expedited;} info={0,0};
    OVERLAPPED ov;memset(&ov,0,sizeof(ov));ov.hEvent=CreateEvent(NULL,TRUE,FALSE,NULL);
    if(!ov.hEvent)ExitProcess(4);
    DWORD n=0,error=0;BOOL ok=DeviceIoControl((HANDLE)s,0x12033,NULL,0,&info,sizeof(info),&n,&ov);
    if(!ok) {
        error=GetLastError();
        if(error==ERROR_IO_PENDING) {
            DWORD wait=WaitForSingleObject(ov.hEvent,2000);if(wait!=WAIT_OBJECT_0)ExitProcess(4);
            ok=GetOverlappedResult((HANDLE)s,&ov,&n,FALSE);error=ok?0:GetLastError();
        }
    }
    printf("layout=%s phase=%s afd_query_ok=%d normal=%lu expedited=%lu n=%lu error=%lu\n",
        layout,phase,(int)ok,(unsigned long)info.normal,(unsigned long)info.expedited,(unsigned long)n,(unsigned long)error);
    CloseHandle(ov.hEvent);
}
static void winsock_probe(sock_t s,const char *layout,const char *phase) {
    char bytes[32]={0};WSABUF b;DWORD received=0,flags=MSG_PEEK,returned=0;
    u_long mark=99;
    b.buf=bytes;b.len=(ULONG)sizeof(bytes);
    int result=WSARecv(s,&b,1,&received,&flags,NULL,NULL),error=result?WSAGetLastError():0;
    printf("layout=%s phase=%s wsarecv_peek_result=%d n=%lu flags=%lu error=%d data=%.*s\n",
        layout,phase,result,(unsigned long)received,(unsigned long)flags,error,(int)received,bytes);
    result=WSAIoctl(s,SIOCATMARK,NULL,0,&mark,sizeof(mark),&returned,NULL,NULL);
    error=result?WSAGetLastError():0;
    printf("layout=%s phase=%s wsaioc_atmark_result=%d mark=%lu returned=%lu error=%d\n",
        layout,phase,result,mark,(unsigned long)returned,error);
    overlapped_probe(s,layout,phase);
    afd_probe(s,layout,phase);
    afd_handles_probe(s,layout,phase);
}
#endif
static int run_case(int layout) {
    const char *label=layout==0?"ab_then_oob_then_cd":layout==1?"oob_then_abcd":"abcd_then_oob";
    sock_t l=BAD,p=BAD,s=BAD;int ok=0;
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(0x7f000001u);
#ifdef _WIN32
    int len=sizeof(a);
#else
    socklen_t len=sizeof(a);
#endif
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==BAD)goto done;
    if(bind(l,(struct sockaddr*)&a,sizeof(a))||listen(l,1)||getsockname(l,(struct sockaddr*)&a,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==BAD||connect(p,(struct sockaddr*)&a,sizeof(a)))goto done;
    s=accept(l,NULL,NULL);if(s==BAD)goto done;
    if(layout==0&&send(p,"AB",2,0)!=2)goto done;
    if(layout==2&&send(p,"ABCD",4,0)!=4)goto done;
    if(send(p,"!",1,MSG_OOB)!=1)goto done;
    if(layout==0&&send(p,"CD",2,0)!=2)goto done;
    if(layout==1&&send(p,"ABCD",4,0)!=4)goto done;
    if(shutdown(p,SHUT_SEND))goto done;
    if(!wait_for(s,1))goto done;
    char peek[32]={0};unsigned long mark=0,available=0;
    if(!at_mark(s,&mark)||IOCTL(s,FIONREAD,&available))goto done;
    int n=recv(s,peek,sizeof(peek),MSG_PEEK);if(n<0)goto done;
    printf("layout=%s initial_atmark=%lu available=%lu peek=%.*s peek_len=%d\n",
        label,mark,available,n,peek,n);
#ifdef _WIN32
    winsock_probe(s,label,"initial");
#endif
    for(int i=0;i<4;i++) {
        char byte=0;
        if(!wait_for(s,0))goto done;
        n=recv(s,&byte,1,0);if(n!=1)goto done;
        mark=0;if(!at_mark(s,&mark))goto done;
        printf("layout=%s read_index=%d byte=%c atmark_after=%lu\n",
            label,i,byte,mark);
        if(i==1) {
            char rest[32]={0};int count=recv(s,rest,sizeof(rest),MSG_PEEK);
            if(count<0)goto done;
            printf("layout=%s after_two_peek=%.*s len=%d\n",
                label,count,rest,count);
#ifdef _WIN32
            winsock_probe(s,label,"after_two");
#endif
        }
    }
    char urgent=0;n=recv(s,&urgent,1,MSG_OOB);int e=n<0?ERR():0;
    printf("layout=%s oob_after_normals=%d byte=%d error=%d\n",
        label,n,(int)(unsigned char)urgent,e);
    ok=1;
done:
    if(s!=BAD)CLOSE(s);
    if(p!=BAD)CLOSE(p);
    if(l!=BAD)CLOSE(l);
    if(!ok)fprintf(stderr,"oracle case failed error=%d\n",ERR());
    return ok;
}
static int late_inline(int layout) {
    const char *label=layout==0?"oob_last":layout==1?"oob_first":layout==2?"repeat_last":layout==3?"repeat_first":"two_urgent";
    int first=layout==1||layout==3;const char *normal=layout>=2?"AAAA":"ABCD";const char *urgent=layout>=2?"A":"!";
    sock_t l=BAD,p=BAD,s=BAD;int ok=0,one=1;
    struct sockaddr_in addr;memset(&addr,0,sizeof(addr));addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(0x7f000001u);
#ifdef _WIN32
    int len=sizeof(addr);
#else
    socklen_t len=sizeof(addr);
#endif
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==BAD)goto done;
    if(bind(l,(struct sockaddr*)&addr,sizeof(addr))||listen(l,1)||getsockname(l,(struct sockaddr*)&addr,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==BAD||connect(p,(struct sockaddr*)&addr,sizeof(addr)))goto done;
    s=accept(l,NULL,NULL);if(s==BAD)goto done;
    if(layout==4) {
        if(send(p,"A",1,0)!=1||send(p,"!",1,MSG_OOB)!=1||send(p,"B",1,0)!=1||
           send(p,"#",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2)goto done;
    } else {
        if(first&&send(p,urgent,1,MSG_OOB)!=1)goto done;
        if(send(p,normal,4,0)!=4)goto done;
        if(!first&&send(p,urgent,1,MSG_OOB)!=1)goto done;
    }
    if(shutdown(p,SHUT_SEND)||!wait_for(s,1))goto done;
    char before=0;int prior=recv(s,&before,1,MSG_OOB|MSG_PEEK);
    if(prior!=1)goto done;
    if(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&one,sizeof(one)))goto done;
    unsigned long marker=0;if(!at_mark(s,&marker))goto done;
    char pre[16]={0};int plen=recv(s,pre,sizeof(pre),MSG_PEEK);if(plen<0)goto done;
    printf("layout=%s before_oob=%c late_inline_peek=%.*s length=%d atmark=%lu\n",label,before,plen,pre,plen,marker);
    char oob=0;int r=recv(s,&oob,1,MSG_OOB|MSG_PEEK),e=r<0?ERR():0;
    printf("layout=%s late_inline_oob_peek=%d error=%d\n",label,r,e);
    int zero=0;
    if(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&zero,sizeof(zero)))goto done;
    oob=0;r=recv(s,&oob,1,MSG_OOB|MSG_PEEK);e=r<0?ERR():0;
    printf("layout=%s restored_oob_peek=%d byte=%d error=%d\n",label,r,(int)(unsigned char)oob,e);
    if(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&one,sizeof(one)))goto done;
    char result[16]={0};int count=0;
    while(count<8) {
        char c=0;if(!wait_for(s,0))goto done;
        r=recv(s,&c,1,0);if(r<0)goto done;if(!r)break;
        result[count++]=c;
    }
    printf("layout=%s late_inline_stream=%.*s length=%d\n",label,count,result,count);
    ok=1;
done:
    if(s!=BAD)CLOSE(s);
    if(p!=BAD)CLOSE(p);
    if(l!=BAD)CLOSE(l);
    if(!ok)fprintf(stderr,"late inline oracle failed error=%d\n",ERR());
    return ok;
}
static int arrival_during_inline(void) {
    sock_t l=BAD,p=BAD,s=BAD;int ok=0,one=1,zero=0;
    struct sockaddr_in addr;memset(&addr,0,sizeof(addr));addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(0x7f000001u);
#ifdef _WIN32
    int len=sizeof(addr);
#else
    socklen_t len=sizeof(addr);
#endif
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==BAD)goto done;
    if(bind(l,(struct sockaddr*)&addr,sizeof(addr))||listen(l,1)||getsockname(l,(struct sockaddr*)&addr,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==BAD||connect(p,(struct sockaddr*)&addr,sizeof(addr)))goto done;
    s=accept(l,NULL,NULL);if(s==BAD)goto done;
    if(send(p,"AB",2,0)!=2||send(p,"!",1,MSG_OOB)!=1||!wait_for(s,1))goto done;
    char before=0;if(recv(s,&before,1,MSG_OOB|MSG_PEEK)!=1)goto done;
#ifdef _WIN32
    afd_probe(s,"window","before_toggle");
#endif
    if(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&one,sizeof(one)))goto done;
    if(send(p,"#",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2||shutdown(p,SHUT_SEND))goto done;
    unsigned long available=0;
    for(int i=0;i<2000;i++) {
        if(IOCTL(s,FIONREAD,&available))goto done;
        if(available>=4)break;
#ifdef _WIN32
        Sleep(1);
#else
        struct timespec delay={0,1000000};nanosleep(&delay,NULL);
#endif
    }
    if(available<4)goto done;
#ifdef _WIN32
    afd_probe(s,"window","before_restore");
#endif
    char inline_peek[16]={0};int n=recv(s,inline_peek,sizeof(inline_peek),MSG_PEEK);if(n<0)goto done;
    if(setsockopt(s,SOL_SOCKET,SO_OOBINLINE,(const char*)&zero,sizeof(zero)))goto done;
    char after=0;int r=recv(s,&after,1,MSG_OOB|MSG_PEEK),error=r<0?ERR():0;
#ifdef _WIN32
    afd_probe(s,"window","after_restore");
#endif
    printf("arrival_during_inline before=%c available=%lu inline_peek=%.*s restored_oob=%d byte=%d error=%d\n",
        before,available,n,inline_peek,r,(int)(unsigned char)after,error);
    if(r==1){char consumed=0;if(recv(s,&consumed,1,MSG_OOB)!=1)goto done;}
    char normal[16]={0};int count=0;
    while(count<8) {
        char c=0;if(!wait_for(s,0))goto done;
        r=recv(s,&c,1,0);if(r<0)goto done;if(!r)break;
        normal[count++]=c;
    }
    printf("arrival_during_inline restored_normal=%.*s length=%d\n",count,normal,count);
    ok=1;
done:
    if(s!=BAD)CLOSE(s);
    if(p!=BAD)CLOSE(p);
    if(l!=BAD)CLOSE(l);
    if(!ok)fprintf(stderr,"arrival window oracle failed error=%d\n",ERR());
    return ok;
}
#ifdef _WIN32
static int arrival_without_inline(void) {
    SOCKET l=INVALID_SOCKET,p=INVALID_SOCKET,s=INVALID_SOCKET;int ok=0;
    struct sockaddr_in addr;memset(&addr,0,sizeof(addr));addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(0x7f000001u);
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==INVALID_SOCKET)goto done;
    int len=sizeof(addr);
    if(bind(l,(struct sockaddr*)&addr,sizeof(addr))||listen(l,1)||getsockname(l,(struct sockaddr*)&addr,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==INVALID_SOCKET||connect(p,(struct sockaddr*)&addr,sizeof(addr)))goto done;
    s=accept(l,NULL,NULL);if(s==INVALID_SOCKET)goto done;
    if(send(p,"AB",2,0)!=2||send(p,"!",1,MSG_OOB)!=1||!wait_for(s,1))goto done;
    char before=0;if(recv(s,&before,1,MSG_OOB|MSG_PEEK)!=1)goto done;
    if(send(p,"#",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2||shutdown(p,SD_SEND))goto done;
    unsigned long available=0;
    for(int i=0;i<2000;i++){if(IOCTL(s,FIONREAD,&available))goto done;if(available>=4)break;Sleep(1);}
    if(available<4)goto done;
    afd_probe(s,"control","after_second");
    u_long nonblocking=1;if(ioctlsocket(s,FIONBIO,&nonblocking))goto done;
    char first=0,second=0;
    int n1=recv(s,&first,1,MSG_OOB),error1=n1<0?ERR():0;
    int n2=recv(s,&second,1,MSG_OOB|MSG_PEEK),error2=n2<0?ERR():0;
    printf("arrival_without_inline before=%c available=%lu first=%d byte=%d error=%d second_peek=%d byte=%d error=%d\n",
        before,available,n1,(int)(unsigned char)first,error1,n2,(int)(unsigned char)second,error2);
    char normal[16]={0};int count=0;
    while(count<8){char c=0;if(!wait_for(s,0))goto done;int r=recv(s,&c,1,0);if(r<0)goto done;if(!r)break;normal[count++]=c;}
    printf("arrival_without_inline normal=%.*s length=%d\n",count,normal,count);
    ok=1;
done:
    if(s!=INVALID_SOCKET)closesocket(s);
    if(p!=INVALID_SOCKET)closesocket(p);
    if(l!=INVALID_SOCKET)closesocket(l);
    if(!ok)fprintf(stderr,"control oracle failed error=%d\n",WSAGetLastError());
    return ok;
}
static int phased_oob(void) {
    SOCKET l=INVALID_SOCKET,p=INVALID_SOCKET,s=INVALID_SOCKET;WSAEVENT event=WSA_INVALID_EVENT;
    int ok=0,len;struct sockaddr_in a;memset(&a,0,sizeof(a));
    a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(0x7f000001u);
    l=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(l==INVALID_SOCKET)goto done;
    if(bind(l,(struct sockaddr*)&a,sizeof(a))||listen(l,1))goto done;
    len=sizeof(a);if(getsockname(l,(struct sockaddr*)&a,&len))goto done;
    p=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(p==INVALID_SOCKET||connect(p,(struct sockaddr*)&a,sizeof(a)))goto done;
    s=accept(l,NULL,NULL);if(s==INVALID_SOCKET)goto done;
    event=WSACreateEvent();if(event==WSA_INVALID_EVENT||WSAEventSelect(s,event,FD_READ|FD_OOB|FD_CLOSE))goto done;
    if(send(p,"AB",2,0)!=2||!wait_for(s,0))goto done;
    char c=0;if(recv(s,&c,1,0)!=1||c!='A')goto done;
    WSANETWORKEVENTS events;
    if(WSAEnumNetworkEvents(s,event,&events))goto done;
    printf("phase=before_urgent events=%ld\n",events.lNetworkEvents);
    if(send(p,"!",1,MSG_OOB)!=1||send(p,"CD",2,0)!=2||shutdown(p,SD_SEND))goto done;
    int saw_oob=0;
    for(int i=0;i<4&&!saw_oob;i++) {
        DWORD wait=WSAWaitForMultipleEvents(1,&event,TRUE,2000,FALSE);
        if(wait!=WSA_WAIT_EVENT_0||WSAEnumNetworkEvents(s,event,&events))goto done;
        printf("phase=after_urgent events=%ld oob_error=%d\n",events.lNetworkEvents,events.iErrorCode[FD_OOB_BIT]);
        if(events.lNetworkEvents&FD_OOB)saw_oob=1;
    }
    if(!saw_oob)goto done;
    winsock_probe(s,"phased","after_fd_oob");
    if(recv(s,&c,1,0)!=1||c!='B')goto done;
    winsock_probe(s,"phased","after_prefix");
    if(recv(s,&c,1,MSG_OOB)!=1||c!='!')goto done;
    printf("phase=phased_oob_received byte=%c\n",c);ok=1;
done:
    if(s!=INVALID_SOCKET)closesocket(s);
    if(p!=INVALID_SOCKET)closesocket(p);
    if(l!=INVALID_SOCKET)closesocket(l);
    if(event!=WSA_INVALID_EVENT)WSACloseEvent(event);
    if(!ok)fprintf(stderr,"phased oracle failed error=%d\n",WSAGetLastError());
    return ok;
}
#endif
int main(void) {
#ifdef _WIN32
    WSADATA data;if(WSAStartup(MAKEWORD(2,2),&data))return 2;
#endif
    int ok=run_case(0)&&run_case(1)&&run_case(2)&&late_inline(0)&&late_inline(1)&&late_inline(2)&&late_inline(3)&&late_inline(4)&&arrival_during_inline();
#ifdef _WIN32
    if(ok)ok=arrival_without_inline()&&phased_oob();
    WSACleanup();
#endif
    return ok?0:1;
}
