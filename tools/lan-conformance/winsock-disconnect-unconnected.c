#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
void entry(void){WSADATA data;DWORD family,inbound,mode,written,protect;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=0;family<2;family++)for(inbound=0;inbound<2;inbound++)for(mode=0;mode<4;mode++){
        SOCKET source=socket(family?AF_INET6:AF_INET,SOCK_STREAM,6);struct sockaddr_storage address;int size=sizeof(address),value,error;
        WSABUF*buffer=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);char*payload=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
        buffer->len=8;buffer->buf=payload;if(mode==1)VirtualProtect(buffer,4096,PAGE_NOACCESS,&protect);if(mode==2)VirtualProtect(payload,4096,PAGE_NOACCESS,&protect);if(mode==3)VirtualProtect(buffer,4096,PAGE_READONLY,&protect);
        SetLastError(0x1234);value=inbound?WSARecvDisconnect(source,mode?buffer:0):WSASendDisconnect(source,mode?buffer:0);error=WSAGetLastError();
        record(family?AF_INET6:AF_INET);record(inbound);record(mode);record(value);record(error);record(getsockname(source,(struct sockaddr*)&address,&size)==0);
        closesocket(source);VirtualFree(buffer,0,MEM_RELEASE);VirtualFree(payload,0,MEM_RELEASE);
    }
    record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);}
