#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];static DWORD used=3,raw[128],raw_used,calls;static BYTE output[8192];static WSAOVERLAPPED *expected;
static void record(DWORD n){oracle_results[used++]=n;}static void detail(DWORD n){raw[raw_used++]=n;}
static void CALLBACK completion(DWORD error,DWORD bytes,WSAOVERLAPPED *ov,DWORD flags){MEMORY_BASIC_INFORMATION info;calls++;record(error);record(bytes==0?0:bytes%76==0?1:2);record(ov==expected);record(ov==0);record(flags);DWORD valid=VirtualQuery(ov,&info,sizeof(info));record(valid==sizeof(info));detail((DWORD)ov);detail((DWORD)expected);detail((DWORD)info.AllocationBase);detail(info.RegionSize);detail(info.State);detail(info.Protect);if(valid&&info.State==MEM_COMMIT&&!(info.Protect&(PAGE_GUARD|PAGE_NOACCESS))){DWORD *p=(DWORD*)ov;for(DWORD i=0;i<12;i++)detail(p[i]);}}
static BOOL save(const char *name,const void *p,DWORD size){DWORD n;HANDLE f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(f==INVALID_HANDLE_VALUE)return FALSE;BOOL ok=WriteFile(f,p,size,&n,0)&&n==size;CloseHandle(f);return ok;}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));for(DWORD creation=0;creation<2;creation++){SOCKET s=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,creation);WSAOVERLAPPED ov={0};DWORD bytes=0xdeadbeef;expected=&ov;calls=0;record(creation);record(WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,output,sizeof(output),&bytes,&ov,completion));record(GetLastError());record(SleepEx(100,TRUE));record(calls);closesocket(s);}record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;if(!save("topology-apc-content.bin",raw,raw_used*4)||!save("lan-oracle.bin",(const void*)oracle_results,used*4))ExitProcess(1);ExitProcess(0);}
