#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3,cancelled,cancel_error;static SOCKET local,peer;static OVERLAPPED *target;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *data,DWORD size){BYTE *p=data;while(size--)*p++=0;}
static DWORD WINAPI sender(void *arg){
    (void)arg;Sleep(50);SetLastError(0);cancelled=CancelIoEx((HANDLE)local,target);cancel_error=GetLastError();
    Sleep(100);send(peer,"abc",3,0);return 0;
}
static void run(BOOL with_overlapped){
    struct sockaddr_in a,b;int length=sizeof(a),ok;OVERLAPPED ov;HANDLE thread,event;
    DWORD bytes=0xfeed,timeout=40;u_long nonblocking=1;char buffer[8];
    local=WSASocketA(AF_INET,SOCK_DGRAM,IPPROTO_UDP,0,0,0);peer=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
    zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);b=a;
    bind(local,(struct sockaddr *)&a,sizeof(a));bind(peer,(struct sockaddr *)&b,sizeof(b));
    getsockname(local,(struct sockaddr *)&a,&length);length=sizeof(b);getsockname(peer,(struct sockaddr *)&b,&length);
    connect(local,(struct sockaddr *)&b,sizeof(b));connect(peer,(struct sockaddr *)&a,sizeof(a));
    ioctlsocket(local,FIONBIO,&nonblocking);setsockopt(local,SOL_SOCKET,SO_RCVTIMEO,(const char *)&timeout,4);
    event=CreateEventA(0,TRUE,FALSE,0);zero(&ov,sizeof(ov));ov.hEvent=event;ov.Offset=0x11223344;
    target=with_overlapped?&ov:0;zero(buffer,8);cancelled=0xfeed;cancel_error=0xfeed;
    thread=CreateThread(0,0,sender,0,0,0);SetLastError(0);ok=ReadFile((HANDLE)local,buffer,8,&bytes,target);
    record(ok);record(GetLastError());record(bytes);record(buffer[0]);record(buffer[2]);
    WaitForSingleObject(thread,1000);record(cancelled);record(cancel_error);
    if(with_overlapped){record((DWORD)ov.Internal);record((DWORD)ov.InternalHigh);record(ov.Offset);record(WaitForSingleObject(event,0));}
    if(!ok)record(recv(local,buffer,8,0));else record(0);
    CloseHandle(event);CloseHandle(thread);closesocket(local);closesocket(peer);
}
void entry(void){
    WSADATA data;HANDLE output;DWORD written;
    WSAStartup(MAKEWORD(2,2),&data);run(FALSE);run(TRUE);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void *)oracle_results,count*4,&written,0);CloseHandle(output);}
    ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
