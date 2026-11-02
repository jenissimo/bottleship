#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void result(int value){record(value);record(value<0?WSAGetLastError():0);}
static void probe(int iocp){
    WSADATA data;WSAPROTOCOL_INFOA info;SOCKET source,raw,peer,alias;struct sockaddr_in address;int length=sizeof(address),value;OVERLAPPED ov,*completed=0;DWORD bytes=0xfeed;ULONG_PTR key=0;HANDLE port=0;char buffer[8]={0};
    record(iocp);record(WSAStartup(MAKEWORD(2,2),&data));source=socket(AF_INET,SOCK_DGRAM,17);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    result(bind(source,(struct sockaddr*)&address,sizeof(address)));result(getsockname(source,(struct sockaddr*)&address,&length));result(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;zero(&ov,sizeof(ov));
    if(iocp){port=CreateIoCompletionPort((HANDLE)raw,0,42,0);record(port!=0);}else{ov.hEvent=CreateEventA(0,TRUE,FALSE,0);record(ov.hEvent!=0);}
    SetLastError(0);value=ReadFile((HANDLE)raw,buffer,sizeof(buffer),&bytes,&ov);record(value);record(value?0:GetLastError());record(bytes);record(ov.Internal);
    record(WSACleanup());record(WSAStartup(MAKEWORD(2,2),&data));peer=socket(AF_INET,SOCK_DGRAM,17);result(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));
    if(iocp){SetLastError(0);value=GetQueuedCompletionStatus(port,&bytes,&key,&completed,1000);record(value);record(value?0:GetLastError());record(bytes);record(key);record(completed==&ov);}
    else{record(WaitForSingleObject(ov.hEvent,1000));SetLastError(0);value=GetOverlappedResult((HANDLE)raw,&ov,&bytes,FALSE);record(value);record(value?0:GetLastError());record(bytes);}
    record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(alias!=INVALID_SOCKET);record(alias==INVALID_SOCKET?WSAGetLastError():0);result(closesocket(alias));result(closesocket(peer));record(WSACleanup());
    if(port)CloseHandle(port);if(ov.hEvent)CloseHandle(ov.hEvent);
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){probe(0);probe(1);finish();}
