#define _WIN32_WINNT 0x0601
#define NTDDI_VERSION 0x06010000
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];static DWORD used=3,raw[2048],raw_used,callback_count,callback_pointer,callback_bytes;static BYTE output[131072];
static void record(DWORD n){oracle_results[used++]=n;}static void detail(DWORD n){if(raw_used<2048)raw[raw_used++]=n;}
static void CALLBACK completion(DWORD error,DWORD bytes,WSAOVERLAPPED *ov,DWORD flags){callback_count++;callback_pointer=(DWORD)ov;callback_bytes=bytes;detail(0x43424b);detail(error);detail(bytes);detail((DWORD)ov);detail(flags);}
static BOOL save(const char *name,const void *p,DWORD size){DWORD n;HANDLE f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(f==INVALID_HANDLE_VALUE)return FALSE;BOOL ok=WriteFile(f,p,size,&n,0)&&n==size;CloseHandle(f);return ok;}
static void probe_prefix(ULONG family){
 ULONG size=sizeof(output);DWORD status=GetAdaptersAddresses(family,GAA_FLAG_INCLUDE_PREFIX,0,(IP_ADAPTER_ADDRESSES*)output,&size);record(status);BOOL bounded=TRUE;DWORD adapters=0;
 for(IP_ADAPTER_ADDRESSES *a=status?0:(IP_ADAPTER_ADDRESSES*)output;a&&adapters++<64;a=a->Next){DWORD count=0;detail(0x414450);detail(a->IfType);detail(a->Flags);detail(a->Length);
  for(IP_ADAPTER_UNICAST_ADDRESS *u=a->FirstUnicastAddress;u&&count++<64;u=u->Next){detail(0x554e49);detail(u->Address.lpSockaddr->sa_family);detail(u->OnLinkPrefixLength);}
  count=0;for(IP_ADAPTER_PREFIX *p=a->FirstPrefix;p&&count++<128;p=p->Next){detail(0x505246);detail(p->Address.lpSockaddr->sa_family);detail(p->PrefixLength);BYTE *b=(BYTE*)p->Address.lpSockaddr;DWORD len=p->Address.iSockaddrLength;BOOL allzero=TRUE;for(DWORD i=p->Address.lpSockaddr->sa_family==AF_INET?4:8;i<(p->Address.lpSockaddr->sa_family==AF_INET?8:24);i++)allzero&=b[i]==0;detail(allzero);bounded&=len==(p->Address.lpSockaddr->sa_family==AF_INET?16:28);}bounded&=count<128;
 }record(adapters>0&&adapters<64&&bounded);
}
static void probe_apc(DWORD creation){
 SOCKET s=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,creation);WSAOVERLAPPED ov={0};DWORD bytes=0xdeadbeef;callback_count=callback_pointer=callback_bytes=0;
 ov.hEvent=CreateEventA(0,TRUE,FALSE,0);detail(0x435458);detail(creation);detail((DWORD)&ov);detail((DWORD)&bytes);detail((DWORD)output);detail((DWORD)&ov.InternalHigh);detail((DWORD)ov.hEvent);
 record(WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,output,sizeof(output),&bytes,&ov,completion));record(GetLastError());record(SleepEx(100,TRUE));record(callback_count);record(callback_bytes==0?0:callback_bytes%76==0?1:2);record(callback_pointer==0);record(callback_pointer==(DWORD)&ov);detail(0x444946);detail(callback_pointer-(DWORD)&ov);
 closesocket(s);CloseHandle(ov.hEvent);
}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));probe_prefix(AF_INET);probe_prefix(AF_INET6);probe_apc(0);probe_apc(1);record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;if(!save("topology-structures-raw.bin",raw,raw_used*4)||!save("lan-oracle.bin",(const void*)oracle_results,used*4))ExitProcess(1);ExitProcess(0);}
