#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void probe(DWORD mode){
    SOCKET source=socket(AF_INET,SOCK_DGRAM,17),peer=socket(AF_INET,SOCK_DGRAM,17),raw,issued;
    WSAPROTOCOL_INFOA info;struct sockaddr_in address;OVERLAPPED ov,*returned=0;
    DWORD bytes=0xfeed;ULONG_PTR key=0xfeed;HANDLE port,associated;int size=sizeof(address);BOOL value;char buffer[8]={0};
    record(mode);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(getsockname(source,(struct sockaddr*)&address,&size));
    outcome(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;
    port=CreateIoCompletionPort((HANDLE)(mode==1?source:raw),0,42,1);record(port!=0);
    SetLastError(0x1234);associated=CreateIoCompletionPort((HANDLE)(mode==1?raw:source),port,43,1);record(associated!=0);record(GetLastError());
    issued=mode==2?source:raw;zero(&ov,sizeof(ov));SetLastError(0x2345);
    value=ReadFile((HANDLE)issued,buffer,sizeof(buffer),&bytes,&ov);record(value);record(GetLastError());record(bytes);record(ov.Internal);record(ov.InternalHigh);
    if(mode!=1){SetLastError(0x3456);record(CloseHandle((HANDLE)raw));record(GetLastError());}
    outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));Sleep(30);
    record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    SetLastError(0x4567);value=GetQueuedCompletionStatus(port,&bytes,&key,&returned,1000);
    record(value);record(GetLastError());record(bytes);record(key);record(returned==&ov);record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    if(mode==1)CloseHandle((HANDLE)raw);outcome(closesocket(source));outcome(closesocket(peer));CloseHandle(port);
}
void entry(void){WSADATA data;DWORD written;HANDLE output;record(WSAStartup(MAKEWORD(2,2),&data));probe(0);probe(1);probe(2);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
