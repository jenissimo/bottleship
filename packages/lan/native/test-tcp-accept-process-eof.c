/* An unexpected data-pipe EOF retires live sockets before process exit. */
#ifdef _WIN32
#define main tcp_accept_process_smoke_main
#include "test-tcp-accept-process.c"
#undef main
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
    event(output,&r,TCP_ACTOR_GRANT_RESULT);assert(u32(r.bytes+16)==TCP_ACCEPT_ADMITTED);
    assert(u64(r.bytes+28));CloseHandle(data);
    assert(WaitForSingleObject(pi.hProcess,5000)==WAIT_OBJECT_0);DWORD code;
    assert(GetExitCodeProcess(pi.hProcess,&code)&&code==1);
    fd_set set;struct timeval timeout={5,0};FD_ZERO(&set);FD_SET(peer,&set);
    assert(select(0,&set,NULL,NULL,&timeout)>0);char byte;assert(recv(peer,&byte,1,0)==0);
    CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(output);CloseHandle(control);closesocket(peer);WSACleanup();
    puts("tcp accept process EOF cleanup: ok");return 0;
}
#else
#include <stdio.h>
int main(void){puts("Windows process EOF skipped");return 0;}
#endif
