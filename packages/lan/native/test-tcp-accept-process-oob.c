/* Real Windows process: urgent data, mark ordering, credit and socket options. */
#ifdef _WIN32
#define TCP_RECEIVE_TEST_NO_MAIN
#include "test-tcp-accept-process-receive.c"
static void option(HANDLE control,HANDLE output,uint64_t child,uint64_t permit,unsigned id,unsigned op,unsigned enabled) {
    unsigned char cmd[64];struct read_state r;
    frame(cmd,TCP_ACTOR_OPTION,id,24);p64(cmd+16,child);p64(cmd+24,permit);
    p32(cmd+32,op);p32(cmd+36,enabled);send_frame(control,cmd,40);
    event(output,&r,TCP_ACTOR_OPTION_DONE);
    assert(u32(r.bytes+8)==id&&u64(r.bytes+16)==child&&u64(r.bytes+24)==permit);
    assert(u32(r.bytes+32)==op&&u32(r.bytes+36)==enabled&&u32(r.bytes+40)==0);
}
int main(int argc,char **argv) {
    (void)any_event;
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
    SOCKET a=open_peer(port);uint64_t ca=grant_peer(data,output,17);
    SOCKET b=open_peer(port);uint64_t cb=grant_peer(data,output,18);
    option(control,output,ca,17,30,0,0);
    option(control,output,cb,18,31,0,1);
    option(control,output,ca,17,32,1,1);
    option(control,output,cb,18,33,1,0);
    option(control,output,ca,17,34,2,1);
    option(control,output,cb,18,35,2,0);
    assert(send(a,"AB",2,0)==2);assert(send(a,"!",1,MSG_OOB)==1);assert(send(a,"CD",2,0)==2);
    credit(data,ca,17,2,36);expect_data(output,ca,"AB",2);
    credit(data,ca,17,1,37);event(output,&r,TCP_ACTOR_OOB);
    assert(u64(r.bytes+16)==ca&&u64(r.bytes+24)==17&&r.length==33&&r.bytes[32]=='!');
    credit(data,ca,17,2,38);expect_data(output,ca,"CD",2);
    assert(send(b,"QR",2,0)==2);assert(send(b,"#",1,MSG_OOB)==1);assert(send(b,"ST",2,0)==2);
    credit(data,cb,18,5,39);expect_data(output,cb,"QR#ST",5);
    CloseHandle(data);CloseHandle(control);assert(WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0);
    DWORD code;assert(GetExitCodeProcess(pi.hProcess,&code)&&code==1);
    CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(output);closesocket(a);closesocket(b);WSACleanup();
    puts("tcp accept process OOB/options: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("Windows process OOB skipped");return 0;}
#endif
