#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];static DWORD count=3;static void record(DWORD v){oracle_results[count++]=v;}
static void info(HANDLE handle){DWORD flags=0xfeed;SetLastError(0x2345);BOOL value=GetHandleInformation(handle,&flags);record(value);record(GetLastError());record(flags);}
static void probe(DWORD mode,DWORD import_flags){WSAPROTOCOL_INFOA pi;SOCKET source=mode==0?socket(AF_INET,SOCK_DGRAM,17):WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,mode==1?0:mode==2?1:mode==3?0x80:0x81);SOCKET imported;
 record(mode);record(import_flags);record(source!=INVALID_SOCKET);info((HANDLE)source);
 SetLastError(0x1234);record(WSADuplicateSocketA(source,GetCurrentProcessId(),&pi));record(WSAGetLastError());record(pi.dwProviderReserved!=0);info((HANDLE)pi.dwProviderReserved);
 SetLastError(0x3456);imported=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&pi,0,import_flags);record(imported!=INVALID_SOCKET);record(WSAGetLastError());record(imported==pi.dwProviderReserved);info((HANDLE)imported);info((HANDLE)source);
 closesocket(imported);closesocket(source);
}
void entry(void){WSADATA data;DWORD i,j,written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&data));for(i=0;i<5;i++)for(j=0;j<2;j++)probe(i,j?0x81:1);record(WSACleanup());
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
