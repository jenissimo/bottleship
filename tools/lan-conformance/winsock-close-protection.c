#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];static DWORD count=3;static void record(DWORD v){oracle_results[count++]=v;}
void entry(void){WSADATA data;DWORD i,flags,written;HANDLE file;SOCKET s;record(WSAStartup(MAKEWORD(2,2),&data));for(i=0;i<2;i++){
 s=i?WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,0x81):socket(AF_INET,SOCK_DGRAM,17);record(i);record(s!=INVALID_SOCKET);
 SetLastError(0x1234);record(SetHandleInformation((HANDLE)s,2,2));record(GetLastError());SetLastError(0x2345);record(closesocket(s));record(WSAGetLastError());
 flags=0xfeed;SetLastError(0x3456);record(GetHandleInformation((HANDLE)s,&flags));record(GetLastError());record(flags);
 SetLastError(0x4567);record(SetHandleInformation((HANDLE)s,2,0));record(GetLastError());SetLastError(0x5678);record(closesocket(s));record(WSAGetLastError());}
 record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
