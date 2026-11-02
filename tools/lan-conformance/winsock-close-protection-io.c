#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];static DWORD count=3;static void record(DWORD v){oracle_results[count++]=v;}static void result(int v){record(v);record(WSAGetLastError());}
static int ready(SOCKET s){fd_set f;struct timeval t={0,100000};FD_ZERO(&f);FD_SET(s,&f);return select(0,&f,0,0,&t);}
void entry(void){WSADATA w;SOCKET source,peer;struct sockaddr_in a={0},b={0};int n;char c=0;DWORD written;HANDLE file;record(WSAStartup(MAKEWORD(2,2),&w));source=socket(AF_INET,SOCK_DGRAM,17);peer=socket(AF_INET,SOCK_DGRAM,17);a.sin_family=b.sin_family=AF_INET;a.sin_addr.s_addr=b.sin_addr.s_addr=htonl(INADDR_LOOPBACK);record(bind(source,(struct sockaddr*)&a,sizeof(a)));record(bind(peer,(struct sockaddr*)&b,sizeof(b)));n=sizeof(a);record(getsockname(source,(struct sockaddr*)&a,&n));n=sizeof(b);record(getsockname(peer,(struct sockaddr*)&b,&n));record(SetHandleInformation((HANDLE)source,2,2));SetLastError(0x1234);result(closesocket(source));
 SetLastError(0x2345);result(sendto(source,"a",1,0,(struct sockaddr*)&b,sizeof(b)));n=ready(peer);record(n);if(n>0){result(recv(peer,&c,1,0));record(c);}else{record(0xfeed);record(0xfeed);record(0xfeed);}
 SetLastError(0x3456);result(sendto(peer,"b",1,0,(struct sockaddr*)&a,sizeof(a)));n=ready(source);record(n);if(n>0){result(recv(source,&c,1,0));record(c);}else{record(0xfeed);record(0xfeed);record(0xfeed);}
 record(SetHandleInformation((HANDLE)source,2,0));result(closesocket(source));closesocket(peer);record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void*)oracle_results,count*4,&written,0);CloseHandle(file);}ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
