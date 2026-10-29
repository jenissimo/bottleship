/* Real process: receive credit/EOF, half-close and isolated remote reset. */
#ifdef _WIN32
#define main tcp_accept_process_smoke_main
#include "test-tcp-accept-process.c"
#undef main
static SOCKET open_peer(uint16_t port) {
    SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);assert(s!=INVALID_SOCKET);
    struct sockaddr_in a;memset(&a,0,sizeof(a));a.sin_family=AF_INET;
    a.sin_addr.s_addr=htonl(0x7f000001u);a.sin_port=htons(port);
    assert(connect(s,(struct sockaddr*)&a,sizeof(a))==0);return s;
}
static uint64_t grant_peer(HANDLE data,HANDLE output,uint64_t permit) {
    struct read_state r;unsigned char cmd[64];event(output,&r,TCP_ACTOR_NEED);
    frame(cmd,TCP_ACTOR_GRANT,(unsigned)permit,8);p64(cmd+16,permit);send_frame(data,cmd,24);
    event(output,&r,TCP_ACTOR_GRANT_RESULT);assert(u32(r.bytes+16)==TCP_ACCEPT_ADMITTED);
    assert(u64(r.bytes+20)==permit);uint64_t child=u64(r.bytes+28);assert(child);return child;
}
static void credit(HANDLE data,uint64_t child,uint64_t permit,unsigned n,unsigned id) {
    unsigned char cmd[64];frame(cmd,TCP_ACTOR_CREDIT,id,20);p64(cmd+16,child);p64(cmd+24,permit);p32(cmd+32,n);send_frame(data,cmd,36);
}
static void any_event(HANDLE output,struct read_state *r) {
    memset(r,0,sizeof(*r));r->pipe=output;HANDLE thread=CreateThread(NULL,0,read_event,r,0,NULL);assert(thread);
    assert(WaitForSingleObject(thread,5000)==WAIT_OBJECT_0);CloseHandle(thread);assert(r->ok);
}
static void expect_data(HANDLE output,uint64_t child,const char *expected,unsigned length) {
    struct read_state r;unsigned got=0;
    while(got<length) {
        event(output,&r,TCP_ACTOR_DATA);assert(u64(r.bytes+16)==child);
        unsigned n=r.length-32;assert(n&&n<=length-got);
        assert(memcmp(r.bytes+32,expected+got,n)==0);got+=n;
    }
}
#ifndef TCP_RECEIVE_TEST_NO_MAIN
int main(int argc,char **argv) {
    assert(argc==2);WSADATA wsa;assert(WSAStartup(MAKEWORD(2,2),&wsa)==0);
    HANDLE child_data,data,child_control,control,output,child_output;
    pipes(&child_data,&data);pipes(&child_control,&control);pipes(&output,&child_output);
    assert(SetHandleInformation(output,HANDLE_FLAG_INHERIT,0));
    assert(SetHandleInformation(child_output,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT));
    STARTUPINFOA si;PROCESS_INFORMATION pi;memset(&si,0,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdInput=child_data;si.hStdOutput=child_output;si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
    char command[2048];int len=snprintf(command,sizeof(command),"\"%s\" 127.0.0.1 0 127.0.0.1 2 19 %lu",argv[1],(unsigned long)(uintptr_t)child_control);
    assert(len>0&&(size_t)len<sizeof(command));memset(&pi,0,sizeof(pi));
    assert(CreateProcessA(NULL,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi));
    HANDLE job=own_process(pi.hProcess);CloseHandle(pi.hThread);CloseHandle(child_data);CloseHandle(child_control);CloseHandle(child_output);
    struct read_state r;event(output,&r,TCP_ACTOR_READY);uint16_t port=(uint16_t)u32(r.bytes+16);
    SOCKET peer_a=open_peer(port);uint64_t child_a=grant_peer(data,output,17);
    SOCKET peer_b=open_peer(port);uint64_t child_b=grant_peer(data,output,18);
    unsigned char cmd[64];
    /* Half-close local send first; receive remains live. */
    frame(cmd,TCP_ACTOR_FIN,30,16);p64(cmd+16,child_b);p64(cmd+24,18);send_frame(data,cmd,32);
    event(output,&r,TCP_ACTOR_FINISHED);assert(u64(r.bytes+16)==child_b);
    fd_set set;struct timeval timeout={5,0};FD_ZERO(&set);FD_SET(peer_b,&set);assert(select(0,&set,NULL,NULL,&timeout)>0);
    char byte;assert(recv(peer_b,&byte,1,0)==0);
    assert(send(peer_b,"HELLO",5,0)==5);
    credit(data,child_b,18,3,31);expect_data(output,child_b,"HEL",3);
    credit(data,child_b,18,2,32);expect_data(output,child_b,"LO",2);
    assert(shutdown(peer_b,SD_SEND)==0);
    credit(data,child_b,18,1,33);event(output,&r,TCP_ACTOR_EOF);assert(u64(r.bytes+16)==child_b);
    /* A's reset must produce an exact child error while B and listener survive. */
    struct linger reset={1,0};assert(setsockopt(peer_a,SOL_SOCKET,SO_LINGER,(const char*)&reset,sizeof(reset))==0);
    closesocket(peer_a);event(output,&r,TCP_ACTOR_CHILD_ERROR);
    assert(u64(r.bytes+16)==child_a&&u64(r.bytes+24)==17&&u32(r.bytes+32)!=0);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,38,16);p64(cmd+16,child_a);p64(cmd+24,17);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_CLOSE_RETIRED);assert(u32(r.bytes+8)==38&&u64(r.bytes+16)==child_a);
    frame(cmd,TCP_ACTOR_OPTION,45,24);p64(cmd+16,child_a);p64(cmd+24,17);p32(cmd+32,1);p32(cmd+36,1);
    send_frame(control,cmd,40);event(output,&r,TCP_ACTOR_OPTION_DONE);
    assert(u32(r.bytes+8)==45&&u64(r.bytes+16)==child_a&&u32(r.bytes+40)!=0);
    frame(cmd,TCP_ACTOR_CONTROL_FENCE,39,16);p64(cmd+16,child_a);p64(cmd+24,17);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_FENCE_DONE);
    frame(cmd,TCP_ACTOR_BARRIER,42,16);p64(cmd+16,child_a);p64(cmd+24,17);send_frame(data,cmd,32);
    event(output,&r,TCP_ACTOR_BARRIER_DONE);
    SOCKET peer_c=open_peer(port);uint64_t child_c=grant_peer(data,output,19);assert(child_c!=child_a&&child_c!=child_b);
    /* Race reset against CLOSE; exactly one physical retirement is emitted,
       and a late CLOSE is acknowledged without a second quota release. */
    assert(setsockopt(peer_c,SOL_SOCKET,SO_LINGER,(const char*)&reset,sizeof(reset))==0);
    closesocket(peer_c);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,41,16);p64(cmd+16,child_c);p64(cmd+24,19);send_frame(control,cmd,32);
    any_event(output,&r);assert(u64(r.bytes+16)==child_c);
    if(r.bytes[5]==TCP_ACTOR_CHILD_ERROR) {
        event(output,&r,TCP_ACTOR_CLOSE_RETIRED);assert(u64(r.bytes+16)==child_c);
    } else assert(r.bytes[5]==TCP_ACTOR_CHILD_CLOSED);
    frame(cmd,TCP_ACTOR_CONTROL_FENCE,43,16);p64(cmd+16,child_c);p64(cmd+24,19);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_FENCE_DONE);
    frame(cmd,TCP_ACTOR_BARRIER,44,16);p64(cmd+16,child_c);p64(cmd+24,19);send_frame(data,cmd,32);
    event(output,&r,TCP_ACTOR_BARRIER_DONE);
    frame(cmd,TCP_ACTOR_CLOSE_CHILD,40,16);p64(cmd+16,child_b);p64(cmd+24,18);send_frame(control,cmd,32);
    event(output,&r,TCP_ACTOR_CHILD_CLOSED);assert(u64(r.bytes+16)==child_b);
    CloseHandle(data);CloseHandle(control);assert(WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0);
    DWORD code;assert(GetExitCodeProcess(pi.hProcess,&code)&&code==1);
    CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(output);closesocket(peer_b);WSACleanup();
    puts("tcp accept process receive: ok");return 0;
}
#endif
#else
#include <stdio.h>
int main(void){puts("Windows process receive skipped");return 0;}
#endif
