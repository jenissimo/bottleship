#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD used=3,calls,cb_error,cb_bytes,cb_flags,cb_null,cb_same,cb_thread,owner;static WSAOVERLAPPED *expected;static BYTE output[4096];
static void record(DWORD n){oracle_results[used++]=n;}
static void CALLBACK completion(DWORD error,DWORD bytes,WSAOVERLAPPED *ov,DWORD flags){calls++;cb_error=error;cb_bytes=bytes;cb_flags=flags;cb_null=ov==0;cb_same=ov==expected;cb_thread=GetCurrentThreadId()==owner;}
static void probe(DWORD creation,DWORD routine,DWORD capacity){
 SOCKET s=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,creation);WSAOVERLAPPED ov={0};DWORD bytes=0xdeadbeef;
 HANDLE event=CreateEventA(0,TRUE,TRUE,0);ov.hEvent=event;ov.Internal=0xfeed;ov.InternalHigh=0xbeef;
 calls=cb_error=cb_bytes=cb_flags=cb_null=cb_same=cb_thread=0;expected=&ov;owner=GetCurrentThreadId();record(creation);record(routine);record(capacity);
 SetLastError(0x1234);record(WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,output,capacity,&bytes,&ov,routine?completion:0));record(GetLastError());
 record(WaitForSingleObject(event,100));record(SleepEx(100,TRUE));record(calls);record(cb_error);record(cb_bytes==0?0:cb_bytes%76==0?1:2);record(cb_null);record(cb_same);record(cb_thread);record(cb_flags);
 record(ov.Internal);record(ov.InternalHigh==0?0:ov.InternalHigh%76==0?1:2);record(bytes==0xdeadbeef?0:bytes==0?1:bytes%76==0?2:3);
 closesocket(s);CloseHandle(event);
}
void entry(void){WSADATA data;DWORD creation,routine;record(WSAStartup(MAKEWORD(2,2),&data));for(creation=0;creation<2;creation++)for(routine=0;routine<2;routine++){probe(creation,routine,sizeof(output));probe(creation,routine,75);}record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;DWORD written;HANDLE f=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(f==INVALID_HANDLE_VALUE||!WriteFile(f,(const void*)oracle_results,used*4,&written,0)||written!=used*4)ExitProcess(1);CloseHandle(f);ExitProcess(0);}
