#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count = 3;
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *data, DWORD size) { BYTE *p = data; while (size--) *p++ = 0; }
static void run(DWORD flags) {
    SOCKET local, peer; struct sockaddr_in a,b; int length=sizeof(a), ok;
    OVERLAPPED ov; DWORD bytes, timeout=1000; char buffer[16]; HANDLE event, port;
    local=WSASocketA(AF_INET,SOCK_DGRAM,IPPROTO_UDP,0,0,flags); peer=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
    record(local!=INVALID_SOCKET && peer!=INVALID_SOCKET);
    setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char *)&timeout,4);
    zero(&a,sizeof(a)); a.sin_family=AF_INET; a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); b=a;
    bind(local,(struct sockaddr *)&a,sizeof(a)); bind(peer,(struct sockaddr *)&b,sizeof(b));
    getsockname(local,(struct sockaddr *)&a,&length); length=sizeof(b); getsockname(peer,(struct sockaddr *)&b,&length);
    connect(local,(struct sockaddr *)&b,sizeof(b)); connect(peer,(struct sockaddr *)&a,sizeof(a));
    SetLastError(0); record(GetFileType((HANDLE)local)); record(GetLastError());
    bytes=0xfeed; SetLastError(0); ok=WriteFile((HANDLE)local,"abc",3,&bytes,0);
    record(ok); record(GetLastError()); record(bytes); if(ok) record(recv(peer,buffer,16,0));
    else record(0);
    send(peer,"def",3,0); bytes=0xfeed; SetLastError(0); zero(buffer,16);
    ok=ReadFile((HANDLE)local,buffer,16,&bytes,0);
    record(ok); record(GetLastError()); record(bytes); record(buffer[0]); if(!ok) recv(local,buffer,16,0);
    zero(&ov,sizeof(ov)); ov.Offset=0x11223344; ov.OffsetHigh=0x55667788;
    bytes=0xfeed; SetLastError(0); record(WriteFile((HANDLE)local,"ghi",3,&bytes,&ov));
    record(GetLastError()); record(bytes);
    SetLastError(0); record(GetOverlappedResultEx((HANDLE)local,&ov,&bytes,1000,FALSE));
    record(GetLastError()); record(bytes); record((DWORD)ov.Internal); record((DWORD)ov.InternalHigh);
    record(ov.Offset); record(ov.OffsetHigh); record(recv(peer,buffer,16,0));
    event=CreateEventA(0,TRUE,FALSE,0);
    zero(&ov,sizeof(ov)); ov.hEvent=event; bytes=0xfeed; SetLastError(0);
    record(WriteFile((HANDLE)local,"jkl",3,&bytes,&ov)); record(GetLastError()); record(bytes);
    record(WaitForSingleObject(event,1000)); record((DWORD)ov.Internal); record((DWORD)ov.InternalHigh);
    record(recv(peer,buffer,16,0));
    send(peer,"mno",3,0); Sleep(50);
    ResetEvent(event); zero(&ov,sizeof(ov)); ov.hEvent=event; bytes=0xfeed; zero(buffer,16); SetLastError(0);
    record(ReadFile((HANDLE)local,buffer,2,&bytes,&ov)); record(GetLastError()); record(bytes);
    record(WaitForSingleObject(event,1000)); record((DWORD)ov.Internal); record((DWORD)ov.InternalHigh); record(buffer[0]); record(buffer[1]);
    SetLastError(0); record(GetOverlappedResult((HANDLE)local,&ov,&bytes,FALSE)); record(GetLastError()); record(bytes);
    SetLastError(0); port=CreateIoCompletionPort((HANDLE)local,0,42,0); record(port!=0); record(GetLastError());
    if(port) CloseHandle(port);
    CloseHandle(event); closesocket(local); closesocket(peer);
}
void entry(void) {
    WSADATA startup; DWORD written; HANDLE output;
    WSAStartup(MAKEWORD(2,2),&startup); run(0); run(1); record(WSACleanup());
    oracle_results[0]=0x42534c4e; oracle_results[1]=count; oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE) {WriteFile(output,(const void *)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
