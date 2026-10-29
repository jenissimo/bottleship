/* Real stdout pressure: control stays reachable while parent stops draining. */
#ifdef _WIN32
#define main tcp_accept_process_smoke_main
#include "test-tcp-accept-process.c"
#undef main
struct burst_state {HANDLE pipe;uint64_t child;int stopped;};
static DWORD WINAPI write_burst(LPVOID argument) {
    struct burst_state *b=(struct burst_state*)argument;unsigned char cmd[64];DWORD n;
    for(unsigned i=1;i<=20000;i++) {
        frame(cmd,TCP_ACTOR_WRITE,i+10,21);p64(cmd+16,b->child);p64(cmd+24,17);
        p32(cmd+32,i);cmd[36]='X';
        if(!WriteFile(b->pipe,cmd,37,&n,NULL)||n!=37)break;
    }
    b->stopped=1;return 0;
}
static void next_event(HANDLE pipe,struct read_state *r) {
    memset(r,0,sizeof(*r));r->pipe=pipe;HANDLE t=CreateThread(NULL,0,read_event,r,0,NULL);assert(t);
    assert(WaitForSingleObject(t,5000)==WAIT_OBJECT_0);CloseHandle(t);assert(r->ok);
}
int main(int argc,char **argv) {
    assert(argc==2);WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
    HANDLE child_data,data,child_control,control,output,child_output;
    pipes(&child_data,&data);pipes(&child_control,&control);pipes(&output,&child_output);
    assert(SetHandleInformation(output,HANDLE_FLAG_INHERIT,0));
    assert(SetHandleInformation(child_output,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT));
    STARTUPINFOA si;PROCESS_INFORMATION pi;memset(&si,0,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdInput=child_data;si.hStdOutput=child_output;si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
    char command[2048];int len=snprintf(command,sizeof(command),"\"%s\" 127.0.0.1 0 127.0.0.1 1 19 %lu",argv[1],(unsigned long)(uintptr_t)child_control);
    assert(len>0&&(size_t)len<sizeof(command));memset(&pi,0,sizeof(pi));
    assert(CreateProcessA(NULL,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi));
    HANDLE job=own_process(pi.hProcess);
    CloseHandle(pi.hThread);CloseHandle(child_data);CloseHandle(child_control);CloseHandle(child_output);
    struct read_state r;event(output,&r,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(r.bytes+16);
    SOCKET peer=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(peer!=INVALID_SOCKET);
    struct sockaddr_in address;memset(&address,0,sizeof(address));address.sin_family=AF_INET;
    address.sin_addr.s_addr=htonl(0x7f000001u);address.sin_port=htons(port);
    assert(connect(peer,(struct sockaddr*)&address,sizeof(address))==0);
    event(output,&r,TCP_ACTOR_NEED);unsigned char cmd[64];frame(cmd,TCP_ACTOR_GRANT,1,8);p64(cmd+16,17);send_frame(data,cmd,24);
    event(output,&r,TCP_ACTOR_GRANT_RESULT);uint64_t child=u64(r.bytes+28);assert(child);
    struct burst_state burst={data,child,0};HANDLE writer=CreateThread(NULL,0,write_burst,&burst,0,NULL);assert(writer);
    /* A finite wait confirms backpressure before control is sent. */
    assert(WaitForSingleObject(writer,2000)==WAIT_TIMEOUT);
    frame(cmd,TCP_ACTOR_STOP,2,0);send_frame(control,cmd,16);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,3,16);p64(cmd+16,child);p64(cmd+24,17);send_frame(control,cmd,32);
    int stopped=0,closed=0;
    for(unsigned i=0;i<20000&&!closed;i++) {
        next_event(output,&r);
        if(r.bytes[5]==TCP_ACTOR_STOPPED)stopped=1;
        else if(r.bytes[5]==TCP_ACTOR_CHILD_CLOSED){assert(u64(r.bytes+16)==child);closed=1;}
        else assert(r.bytes[5]==TCP_ACTOR_ACK);
    }
    assert(stopped&&closed);
    (void)CancelSynchronousIo(writer);assert(WaitForSingleObject(writer,5000)==WAIT_OBJECT_0);CloseHandle(writer);
    CloseHandle(data);CloseHandle(control);
    assert(WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0);
    DWORD exit_code;assert(GetExitCodeProcess(pi.hProcess,&exit_code)&&exit_code==1);
    unsigned char tail[256];DWORD bytes=0;
    while(ReadFile(output,tail,sizeof(tail),&bytes,NULL)&&bytes) {}
    assert(GetLastError()==ERROR_BROKEN_PIPE);
    CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(output);closesocket(peer);WSACleanup();
    puts("tcp accept process stdout pressure: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("Windows process pressure skipped");return 0;}
#endif
