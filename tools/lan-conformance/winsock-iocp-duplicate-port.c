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
static void probe(BOOL close_before){
    SOCKET source=socket(AF_INET,SOCK_DGRAM,17),peer=socket(AF_INET,SOCK_DGRAM,17);struct sockaddr_in address;
    OVERLAPPED ov,*returned=0;DWORD bytes=0xfeed;ULONG_PTR key=0xfeed;HANDLE first,copy=0;int size=sizeof(address);BOOL value;char buffer[8]={0};
    record(close_before);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(getsockname(source,(struct sockaddr*)&address,&size));
    first=CreateIoCompletionPort((HANDLE)source,0,42,1);record(first!=0);
    record(DuplicateHandle(GetCurrentProcess(),first,GetCurrentProcess(),&copy,0,FALSE,DUPLICATE_SAME_ACCESS));record(copy!=0&&copy!=first);
    if(close_before)record(CloseHandle(first));
    zero(&ov,sizeof(ov));value=ReadFile((HANDLE)source,buffer,sizeof(buffer),&bytes,&ov);record(value);record(GetLastError());record(bytes);record(ov.Internal);record(ov.InternalHigh);
    if(!close_before)record(CloseHandle(first));
    outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));Sleep(30);
    record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    SetLastError(0x4567);value=GetQueuedCompletionStatus(copy,&bytes,&key,&returned,1000);
    record(value);record(GetLastError());record(bytes);record(key);record(returned==&ov);record(ov.Internal);record(ov.InternalHigh);record(buffer[0]);record(buffer[2]);
    closesocket(source);closesocket(peer);CloseHandle(copy);
}
void entry(void){WSADATA data;DWORD written;HANDLE output;record(WSAStartup(MAKEWORD(2,2),&data));probe(FALSE);probe(TRUE);record(WSACleanup());
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
