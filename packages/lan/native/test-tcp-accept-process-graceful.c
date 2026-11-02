/* Owned Windows process/pipe/loopback integration; argv[1] is helper path. */
#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdint.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "tcp-accept-actor.h"
static void p32(unsigned char *p,uint32_t n){p[0]=(unsigned char)n;p[1]=(unsigned char)(n>>8);p[2]=(unsigned char)(n>>16);p[3]=(unsigned char)(n>>24);}
static void p64(unsigned char *p,uint64_t n){p32(p,(uint32_t)n);p32(p+4,(uint32_t)(n>>32));}
static uint32_t u32(const unsigned char *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static uint64_t u64(const unsigned char *p){return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32);}
static void frame(unsigned char *p,unsigned op,unsigned id,unsigned size) {
    memset(p,0,16+size);p32(p,16+size);p[4]=1;p[5]=(unsigned char)op;p32(p+8,id);p32(p+12,19);
}
static void send_frame(HANDLE h,const void *bytes,DWORD length) {
    DWORD written=0;assert(WriteFile(h,bytes,length,&written,NULL)&&written==length);
}
struct read_state {HANDLE pipe;unsigned char bytes[80];unsigned length;int ok;};
static DWORD WINAPI read_event(LPVOID arg) {
    struct read_state *r=(struct read_state*)arg;DWORD n,total=0;
    while(total<16){if(!ReadFile(r->pipe,r->bytes+total,16-total,&n,NULL)||!n)return 0;total+=n;}
    unsigned size=u32(r->bytes);if(size<16||size>sizeof(r->bytes))return 0;
    while(total<size){if(!ReadFile(r->pipe,r->bytes+total,size-total,&n,NULL)||!n)return 0;total+=n;}
    r->length=size;r->ok=1;return 0;
}
static void event(HANDLE pipe,struct read_state *r,unsigned op) {
    memset(r,0,sizeof(*r));r->pipe=pipe;HANDLE thread=CreateThread(NULL,0,read_event,r,0,NULL);assert(thread);
    assert(WaitForSingleObject(thread,5000)==WAIT_OBJECT_0);CloseHandle(thread);
    if(r->ok&&r->bytes[5]!=op)fprintf(stderr,"event expected %u actual %u length %u payload %u\n",op,r->bytes[5],r->length,r->length>32?r->bytes[32]:0);
    assert(r->ok&&r->bytes[4]==1&&r->bytes[5]==op&&u32(r->bytes+12)==19);
}
static void pipes(HANDLE *child_read,HANDLE *parent_write) {
    SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};assert(CreatePipe(child_read,parent_write,&sa,0));
    assert(SetHandleInformation(*parent_write,HANDLE_FLAG_INHERIT,0));
}
static HANDLE own_process(HANDLE process) {
    HANDLE job=CreateJobObjectA(NULL,NULL);assert(job);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;memset(&info,0,sizeof(info));
    info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    assert(SetInformationJobObject(job,JobObjectExtendedLimitInformation,&info,sizeof(info)));
    assert(AssignProcessToJobObject(job,process));return job;
}
int main(int argc,char **argv) {
    assert(argc==2);WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
    HANDLE child_data,data,child_control,control,output,child_output;
    pipes(&child_data,&data);pipes(&child_control,&control);pipes(&output,&child_output);
    /* Reverse the output pipe ownership established by pipes(). */
    assert(SetHandleInformation(output,HANDLE_FLAG_INHERIT,0));
    assert(SetHandleInformation(child_output,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT));
    STARTUPINFOA si;PROCESS_INFORMATION pi;memset(&si,0,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdInput=child_data;si.hStdOutput=child_output;si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
    char command[2048];int len=snprintf(command,sizeof(command),"\"%s\" 127.0.0.1 0 127.0.0.1 1 19 %lu",argv[1],(unsigned long)(uintptr_t)child_control);
    assert(len>0&&(size_t)len<sizeof(command));
    memset(&pi,0,sizeof(pi));
    assert(CreateProcessA(NULL,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi));
    HANDLE job=own_process(pi.hProcess);
    CloseHandle(pi.hThread);CloseHandle(child_data);CloseHandle(child_control);CloseHandle(child_output);
    struct read_state r;event(output,&r,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(r.bytes+16);assert(port);
    SOCKET peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=INVALID_SOCKET);
    struct sockaddr_in address;memset(&address,0,sizeof(address));address.sin_family=AF_INET;
    address.sin_addr.s_addr=htonl(0x7f000001u);address.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&address,sizeof(address))==0);
    event(output,&r,TCP_ACTOR_NEED);
    unsigned char cmd[64];frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data,cmd,24);
    event(output,&r,TCP_ACTOR_GRANT_RESULT);assert(u32(r.bytes+16)==TCP_ACCEPT_ADMITTED);
    uint64_t child=u64(r.bytes+28);assert(child&&u64(r.bytes+20)==17);
    frame(cmd,TCP_ACTOR_STOP,2,0);send_frame(control,cmd,16);event(output,&r,TCP_ACTOR_STOPPED);
    frame(cmd,TCP_ACTOR_WRITE,3,21);p64(cmd+16,child);p64(cmd+24,17);p32(cmd+32,11);cmd[36]='Q';send_frame(data,cmd,37);
    event(output,&r,TCP_ACTOR_ACK);assert(u32(r.bytes+32)==11);
    fd_set set;struct timeval timeout={5,0};FD_ZERO(&set);FD_SET(peer,&set);assert(select(0,&set,NULL,NULL,&timeout)>0);
    char value;assert(recv(peer,&value,1,0)==1&&value=='Q');
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,4,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_CHILD_CLOSED);assert(u64(r.bytes+16)==child&&u64(r.bytes+24)==17);
    frame(cmd,TCP_ACTOR_CONTROL_FENCE,6,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_FENCE_DONE);
    frame(cmd,TCP_ACTOR_BARRIER,5,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(data,cmd,32);
    event(output,&r,TCP_ACTOR_BARRIER_DONE);
    frame(cmd,TCP_ACTOR_QUIESCE,7,0);send_frame(data,cmd,16);
    event(output,&r,TCP_ACTOR_QUIESCED);assert(u32(r.bytes+8)==7);
    frame(cmd,TCP_ACTOR_EXIT,8,0);send_frame(control,cmd,16);
    event(output,&r,TCP_ACTOR_EXITING);assert(u32(r.bytes+8)==8);
    assert(WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0);DWORD code;
    assert(GetExitCodeProcess(pi.hProcess,&code)&&code==0);
    unsigned char tail;DWORD got=0;
    assert(!ReadFile(output,&tail,1,&got,NULL)&&GetLastError()==ERROR_BROKEN_PIPE);
    CloseHandle(data);CloseHandle(control);CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(output);closesocket(peer);WSACleanup();
    puts("tcp Windows graceful process: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("Windows process test skipped");return 0;}
#endif
