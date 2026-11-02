#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3, calls, last_error, last_bytes, callback_thread;
static OVERLAPPED *last_ov;
static void record(DWORD value) {oracle_results[count++]=value;}
static void zero(void *data,DWORD size) {BYTE *p=data;while(size--)*p++=0;}
static void WINAPI completed(DWORD error,DWORD bytes,OVERLAPPED *ov) {
    calls++;last_error=error;last_bytes=bytes;last_ov=ov;callback_thread=GetCurrentThreadId();
}
static DWORD WINAPI sender(void *arg) {Sleep(50);send((SOCKET)arg,"abc",3,0);return 0;}
static void run(DWORD flags) {
    SOCKET local,peer;struct sockaddr_in a,b;int length=sizeof(a);OVERLAPPED ov;
    HANDLE event,thread,port;DWORD timeout=1000,tid=GetCurrentThreadId();char buffer[16];
    local=WSASocketA(AF_INET,SOCK_DGRAM,IPPROTO_UDP,0,0,flags);peer=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
    record(local!=INVALID_SOCKET && peer!=INVALID_SOCKET);
    setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char *)&timeout,4);
    zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);b=a;
    bind(local,(struct sockaddr *)&a,sizeof(a));bind(peer,(struct sockaddr *)&b,sizeof(b));
    getsockname(local,(struct sockaddr *)&a,&length);length=sizeof(b);getsockname(peer,(struct sockaddr *)&b,&length);
    connect(local,(struct sockaddr *)&b,sizeof(b));connect(peer,(struct sockaddr *)&a,sizeof(a));
    event=CreateEventA(0,TRUE,FALSE,0);zero(&ov,sizeof(ov));ov.hEvent=event;ov.Offset=0x11223344;ov.OffsetHigh=0x55667788;
    zero(buffer,16);calls=0;thread=CreateThread(0,0,sender,(void *)peer,0,0);
    SetLastError(0);record(ReadFileEx((HANDLE)local,buffer,16,&ov,completed));record(GetLastError());
    record(calls);record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);record(SleepEx(2000,TRUE));record(calls);record(last_error);record(last_bytes);
    record(last_ov==&ov);record(callback_thread==tid);record(buffer[0]);record(buffer[2]);
    record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);record(ov.Offset);record(ov.OffsetHigh);record(WaitForSingleObject(event,0));
    WaitForSingleObject(thread,1000);CloseHandle(thread);
    zero(&ov,sizeof(ov));ov.hEvent=event;calls=0;SetLastError(0);
    record(WriteFileEx((HANDLE)local,"def",3,&ov,completed));record(GetLastError());record(calls);record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);
    record(SleepEx(2000,TRUE));record(calls);record(last_error);record(last_bytes);record(last_ov==&ov);
    record(recv(peer,buffer,16,0));record(buffer[0]);record(buffer[2]);record(WaitForSingleObject(event,0));
    send(peer,"ghi",3,0);Sleep(50);zero(&ov,sizeof(ov));calls=0;zero(buffer,16);SetLastError(0);
    record(ReadFileEx((HANDLE)local,buffer,2,&ov,completed));record(GetLastError());
    record(SleepEx(2000,TRUE));record(calls);record(last_error);record(last_bytes);record(buffer[0]);record(buffer[1]);
    if(flags) {
        zero(&ov,sizeof(ov));calls=0;record(ReadFileEx((HANDLE)local,buffer,16,&ov,completed));
        record(CancelIoEx((HANDLE)local,&ov));record(SleepEx(2000,TRUE));record(calls);record(last_error);record(last_bytes);
        port=CreateIoCompletionPort((HANDLE)local,0,42,0);record(port!=0);
        zero(&ov,sizeof(ov));SetLastError(0);record(WriteFileEx((HANDLE)local,"jkl",3,&ov,completed));record(GetLastError());
        CloseHandle(port);
    }
    CloseHandle(event);closesocket(local);closesocket(peer);
}
void entry(void) {
    WSADATA startup;DWORD written;HANDLE output;
    WSAStartup(MAKEWORD(2,2),&startup);
#ifdef ORACLE_SYNC_DIAGNOSTIC
    run(0); /* ReadFileEx requires overlapped handles; retain the native diagnostic separately. */
#endif
    run(1);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE) {WriteFile(output,(const void *)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
