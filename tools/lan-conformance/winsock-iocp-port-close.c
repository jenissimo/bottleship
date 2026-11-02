#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void probe(BOOL event){
    SOCKET source=socket(AF_INET,SOCK_DGRAM,17),peer=socket(AF_INET,SOCK_DGRAM,17),raw;
    WSAPROTOCOL_INFOA info;struct sockaddr_in address;OVERLAPPED ov,*returned=0;DWORD bytes=0xfeed;ULONG_PTR key=0xfeed;
    HANDLE first,second,result;BOOL value;int size=sizeof(address);char buffer[8]={0};
    record(event);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(getsockname(source,(struct sockaddr*)&address,&size));
    outcome(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;
    first=CreateIoCompletionPort((HANDLE)source,0,42,1);record(first!=0);record(CloseHandle(first));
    second=CreateIoCompletionPort(INVALID_HANDLE_VALUE,0,0,1);record(second!=0);
    SetLastError(0x1234);result=CreateIoCompletionPort((HANDLE)source,second,43,1);record(result!=0);record(GetLastError());
    SetLastError(0x2345);result=CreateIoCompletionPort((HANDLE)raw,second,44,1);record(result!=0);record(GetLastError());
    zero(&ov,sizeof(ov));if(event)ov.hEvent=CreateEventA(0,TRUE,FALSE,0);
    value=ReadFile((HANDLE)raw,buffer,sizeof(buffer),&bytes,&ov);record(value);record(GetLastError());record(bytes);record(ov.Internal);record(ov.InternalHigh);
    outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));Sleep(30);
    record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);if(event)record(WaitForSingleObject(ov.hEvent,100));
    SetLastError(0x3456);value=GetOverlappedResultEx((HANDLE)source,&ov,&bytes,100,FALSE);
    record(value);record(GetLastError());record(bytes);record(ov.Internal);record(ov.InternalHigh);
    SetLastError(0x4567);value=GetQueuedCompletionStatus(second,&bytes,&key,&returned,100);
    record(value);record(GetLastError());record(bytes);record(key);record(returned==0);
    closesocket(raw);closesocket(source);closesocket(peer);if(event)CloseHandle(ov.hEvent);CloseHandle(second);
}
void entry(void){WSADATA data;DWORD written;HANDLE output;record(WSAStartup(MAKEWORD(2,2),&data));probe(FALSE);probe(TRUE);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
