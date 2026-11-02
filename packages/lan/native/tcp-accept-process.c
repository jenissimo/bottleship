/* Windows source-stage process transport for tcp-accept actor. Apache-2.0.
 * NOT a complete TCP backend: urgent receive, options and POSIX are not implemented.
 * stdin=data, stdout=events, an inherited HANDLE argument=control pipe.
 * Parent owns all quota tokens until CHILD_CLOSED or actual process exit. */
#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include "tcp-accept-framer.h"
#define PROCESS_CHILD_MAX 60
#define INPUT_CHUNK 4096
struct lane { HANDLE handle; unsigned char bytes[INPUT_CHUNK]; DWORD length; int eof; };
static struct lane data_lane,control_lane;
static struct tcp_accept_actor *actor;
static struct tcp_accept_framer *framer;
static CRITICAL_SECTION lock;
static CONDITION_VARIABLE changed;
static HANDLE wake;
static int failed;
struct watch { tcp_accept_socket socket; WSAEVENT event; uint64_t child,permit; int pending_error; };
static struct watch listener_watch,child_watches[PROCESS_CHILD_MAX];
static void signal_main(void) { SetEvent(wake);WakeAllConditionVariable(&changed); }
static void fail(void) { failed=1;signal_main(); }
static DWORD WINAPI input_thread(LPVOID argument) {
    struct lane *lane=(struct lane*)argument;
    for(;;) {
        unsigned char bytes[INPUT_CHUNK];DWORD n=0;
        EnterCriticalSection(&lock);
        while(lane->length&&!failed)SleepConditionVariableCS(&changed,&lock,INFINITE);
        int stop=failed;LeaveCriticalSection(&lock);if(stop)return 0;
        if(!ReadFile(lane->handle,bytes,sizeof(bytes),&n,NULL)||!n) {
            EnterCriticalSection(&lock);lane->eof=1;signal_main();LeaveCriticalSection(&lock);return 0;
        }
        EnterCriticalSection(&lock);
        if(failed){LeaveCriticalSection(&lock);return 0;}
        memcpy(lane->bytes,bytes,n);lane->length=n;signal_main();LeaveCriticalSection(&lock);
    }
}
static DWORD WINAPI output_thread(LPVOID unused) {
    (void)unused;
    for(;;) {
        unsigned char bytes[TCP_ACTOR_HEADER+TCP_ACTOR_BODY_MAX];unsigned size;const unsigned char *p;
        EnterCriticalSection(&lock);
        while(!(p=tcp_framer_output(framer,actor,&size))&&!failed)
            SleepConditionVariableCS(&changed,&lock,INFINITE);
        if(failed){LeaveCriticalSection(&lock);return 0;}
        memcpy(bytes,p,size);LeaveCriticalSection(&lock);
        DWORD written=0;
        if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bytes,size,&written,NULL)||!written) {
            EnterCriticalSection(&lock);fail();LeaveCriticalSection(&lock);return 0;
        }
        EnterCriticalSection(&lock);
        if(!tcp_framer_written(framer,actor,written))fail();else signal_main();
        LeaveCriticalSection(&lock);
    }
}
static int parse_u32(const char *s,uint32_t *value) {
    char *end;unsigned long v;if(!s||!*s)return 0;
    for(const char *p=s;*p;p++)if(*p<'0'||*p>'9')return 0;
    errno=0;v=strtoul(s,&end,10);if(errno||*end||v>UINT32_MAX)return 0;
    *value=(uint32_t)v;return 1;
}
static int parse_acl(const char *text,uint32_t *acl,unsigned *count) {
    unsigned n=0;
    if(!text||!*text)return 0;
    for(;;) {
        const char *end=strchr(text,',');
        size_t len=end?(size_t)(end-text):strlen(text);
        char host[16];struct in_addr address;
        if(!len||len>=sizeof(host)||n>=32)return 0;
        memcpy(host,text,len);host[len]='\0';
        if(inet_pton(AF_INET,host,&address)!=1)return 0;
        acl[n++]=(uint32_t)address.s_addr;
        if(!end)break;
        text=end+1;
    }
    *count=n;return 1;
}
static int parse_handle(const char *s,uintptr_t *value) {
    char *end;unsigned long long v;if(!s||!*s)return 0;
    if(strncmp(s,"fd:",3)==0) {
        uint32_t fd;intptr_t handle;
        if(!parse_u32(s+3,&fd)||fd<3||fd>INT_MAX)return 0;
        handle=_get_osfhandle((int)fd);if(handle==-1)return 0;
        *value=(uintptr_t)handle;return 1;
    }
    for(const char *p=s;*p;p++)if(*p<'0'||*p>'9')return 0;
    errno=0;v=strtoull(s,&end,10);if(errno||*end||!v||v>(unsigned long long)UINTPTR_MAX)return 0;
    *value=(uintptr_t)v;return 1;
}
static int watch_open(struct watch *w,tcp_accept_socket socket,long flags) {
    w->socket=socket;w->event=WSACreateEvent();
    if(w->event==WSA_INVALID_EVENT)return 0;
    if(WSAEventSelect(socket,w->event,flags)==SOCKET_ERROR){WSACloseEvent(w->event);w->event=WSA_INVALID_EVENT;return 0;}
    return 1;
}
static void watch_remove(struct watch *w) {
    if(w->event!=WSA_INVALID_EVENT)WSACloseEvent(w->event);
    w->event=WSA_INVALID_EVENT;w->socket=TCP_ACCEPT_INVALID;
}
static int refresh_watches(void) {
    tcp_accept_socket listener=actor->owner.listener;
    if(listener_watch.socket!=listener) {
        watch_remove(&listener_watch);
        if(listener!=TCP_ACCEPT_INVALID&&!watch_open(&listener_watch,listener,FD_ACCEPT|FD_CLOSE))return 0;
    }
    for(unsigned i=0;i<PROCESS_CHILD_MAX;i++) {
        tcp_accept_socket s=i<actor->owner.limit&&!actor->owner.slots[i].poisoned?
            actor->owner.slots[i].socket:TCP_ACCEPT_INVALID;
        uint64_t child=s==TCP_ACCEPT_INVALID?0:actor->owner.slots[i].child;
        uint64_t permit=s==TCP_ACCEPT_INVALID?0:actor->owner.slots[i].permit;
        if(child_watches[i].socket!=s||child_watches[i].child!=child||child_watches[i].permit!=permit) {
            watch_remove(&child_watches[i]);
            child_watches[i].child=child;child_watches[i].permit=permit;child_watches[i].pending_error=0;
            if(s!=TCP_ACCEPT_INVALID&&!watch_open(&child_watches[i],s,FD_READ|FD_WRITE|FD_OOB|FD_CLOSE))return 0;
        }
    }
    return 1;
}
static int consume(struct lane *lane,int control) {
    unsigned used=0;int result;
    if(!lane->length)return 0;
    result=control?tcp_framer_control(framer,actor,lane->bytes,lane->length,&used):
                   tcp_framer_feed(framer,actor,lane->bytes,lane->length,&used);
    if(result<0){fail();return 0;}
    if(used){lane->length-=used;if(lane->length)memmove(lane->bytes,lane->bytes+used,lane->length);signal_main();}
    return used!=0;
}
int main(int argc,char **argv) {
    uint32_t port,limit,epoch,acl[32];unsigned acl_count;uintptr_t control_value;WSADATA wsa;
    if(argc!=7||!parse_u32(argv[2],&port)||port>65535||
       !parse_u32(argv[4],&limit)||!limit||limit>PROCESS_CHILD_MAX||
       !parse_u32(argv[5],&epoch)||!epoch||!parse_handle(argv[6],&control_value))
        return 2;
    if(WSAStartup(MAKEWORD(2,2),&wsa)!=0)return 2;
    if(!parse_acl(argv[3],acl,&acl_count))return 2;
    data_lane.handle=GetStdHandle(STD_INPUT_HANDLE);control_lane.handle=(HANDLE)control_value;
    if(!data_lane.handle||data_lane.handle==INVALID_HANDLE_VALUE||!control_lane.handle||
       control_lane.handle==INVALID_HANDLE_VALUE||!GetStdHandle(STD_OUTPUT_HANDLE))return 2;
    actor=calloc(1,sizeof(*actor));framer=calloc(1,sizeof(*framer));if(!actor||!framer)return 2;
    if(!tcp_actor_init(actor,epoch,argv[1],(uint16_t)port,acl,acl_count,limit))return 2;
    listener_watch.socket=TCP_ACCEPT_INVALID;listener_watch.event=WSA_INVALID_EVENT;
    for(unsigned i=0;i<PROCESS_CHILD_MAX;i++){child_watches[i].socket=TCP_ACCEPT_INVALID;child_watches[i].event=WSA_INVALID_EVENT;}
    InitializeCriticalSection(&lock);InitializeConditionVariable(&changed);
    wake=CreateEvent(NULL,TRUE,FALSE,NULL);if(!wake)return 2;
    _setmode(0,_O_BINARY);_setmode(1,_O_BINARY);
    HANDLE reader=CreateThread(NULL,0,input_thread,&data_lane,0,NULL);
    HANDLE control=CreateThread(NULL,0,input_thread,&control_lane,0,NULL);
    HANDLE writer=CreateThread(NULL,0,output_thread,NULL,0,NULL);
    if(!reader||!control||!writer)ExitProcess(2);
    for(;;) {
        HANDLE events[PROCESS_CHILD_MAX+2];struct watch *watched[PROCESS_CHILD_MAX+2];DWORD count=0;
        EnterCriticalSection(&lock);ResetEvent(wake);
        if(failed||data_lane.eof||control_lane.eof) {
            (void)tcp_actor_abort(actor);LeaveCriticalSection(&lock);ExitProcess(1);
        }
        int progress=0;
        progress|=consume(&control_lane,1);progress|=consume(&data_lane,0);
        if(!failed&&framer->control_expected&&framer->control_used==framer->control_expected) {
            unsigned used=0;int n=tcp_framer_control(framer,actor,NULL,0,&used);
            if(n<0)fail();else if(n>0)progress=1;
        }
        if(!failed&&framer->expected&&framer->used==framer->expected) {
            unsigned used=0;int n=tcp_framer_feed(framer,actor,NULL,0,&used);
            if(n<0)fail();else if(n>0)progress=1;
        }
        if(!failed&&!refresh_watches())fail();
        if(!failed) {
            int n=tcp_framer_poll_listener(framer,actor);if(n<0)fail();else progress|=n;
            for(unsigned i=0;i<actor->owner.limit;i++) {
                struct tcp_accept_slot *slot=&actor->owner.slots[i];
                if(slot->socket==TCP_ACCEPT_INVALID||slot->poisoned)continue;
                struct watch *w=&child_watches[i];
                if(w->child==slot->child&&w->permit==slot->permit&&w->pending_error) {
                    n=tcp_framer_fail_child(framer,actor,slot->child,slot->permit,w->pending_error);
                    if(n<0){fail();break;}progress|=n;continue;
                }
                if(actor->flows[i].count) {
                    n=tcp_actor_flush_child(actor,slot->child,slot->permit);
                    if(n==-2){w->pending_error=actor->native_error;progress=1;continue;}
                    if(n<0){fail();break;}progress|=n;
                }
                n=tcp_actor_receive_child(actor,slot->child,slot->permit);
                if(n==-2){w->pending_error=actor->native_error;progress=1;continue;}
                if(n<0){fail();break;}progress|=n;
            }
        }
        if(!refresh_watches())fail();
        if(failed){if(actor->native_error)fprintf(stderr,"tcp-accept native error: %d\n",actor->native_error);(void)tcp_actor_abort(actor);LeaveCriticalSection(&lock);ExitProcess(1);}
        if(framer->exit_requested&&!actor->out_count&&!framer->output_offset&&
           !framer->used&&!framer->control_used&&!data_lane.length&&!control_lane.length) {
            LeaveCriticalSection(&lock);ExitProcess(0);
        }
        if(progress){signal_main();LeaveCriticalSection(&lock);continue;}
        events[count]=wake;watched[count++]=NULL;
        if(listener_watch.event!=WSA_INVALID_EVENT){events[count]=listener_watch.event;watched[count++]=&listener_watch;}
        for(unsigned i=0;i<PROCESS_CHILD_MAX;i++)if(child_watches[i].event!=WSA_INVALID_EVENT) {
            events[count]=child_watches[i].event;watched[count++]=&child_watches[i];
        }
        LeaveCriticalSection(&lock);
        DWORD ready=WaitForMultipleObjects(count,events,FALSE,INFINITE);
        if(ready==WAIT_FAILED||ready>=WAIT_OBJECT_0+count)ExitProcess(1);
        if(ready>WAIT_OBJECT_0) {
            struct watch *w=watched[ready-WAIT_OBJECT_0];WSANETWORKEVENTS network;
            if(WSAEnumNetworkEvents(w->socket,w->event,&network)==SOCKET_ERROR)ExitProcess(1);
            for(int bit=0;bit<FD_MAX_EVENTS;bit++) {
                if(!(network.lNetworkEvents&(1L<<bit))||!network.iErrorCode[bit])continue;
                if(w==&listener_watch)ExitProcess(1);
                w->pending_error=network.iErrorCode[bit];
            }
        }
    }
}
#else
#include <stdio.h>
int main(void){fputs("tcp-accept process: POSIX wrapper not implemented\n",stderr);return 2;}
#endif
