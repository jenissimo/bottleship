#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
/* Finite native x86 TCP class-D destination validation; nonblocking only.
 * No listener, Internet endpoint, shared memory, CRT, or retry loop. */
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD used=3;
static void rec(DWORD v){if(used<256)oracle_results[used++]=v;else ExitProcess(91);}
static void zero(void *p,DWORD n){BYTE *b=p;while(n--)*b++=0;}
static DWORD ip(BYTE a,BYTE b,BYTE c,BYTE d){return a|((DWORD)b<<8)|((DWORD)c<<16)|((DWORD)d<<24);}
static void pair(int value){DWORD e=WSAGetLastError();rec(value);rec(e);}
static void name(SOCKET s){struct sockaddr_in a;int n=sizeof(a),r;zero(&a,sizeof(a));WSASetLastError(0x1234);r=getsockname(s,(struct sockaddr*)&a,&n);pair(r);rec(n);rec(a.sin_family);rec(a.sin_addr.s_addr);rec(a.sin_port!=0);}
static void one(int mode){SOCKET s;u_long nb=1;struct sockaddr_in a;fd_set w,x;struct timeval t;int n,err,r;
 rec(mode);WSASetLastError(0x1234);s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);pair(s==INVALID_SOCKET?-1:0);
 WSASetLastError(0x1234);pair(ioctlsocket(s,FIONBIO,&nb));
 if(mode){zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=mode==2?ip(127,0,0,1):0;WSASetLastError(0x1234);pair(bind(s,(struct sockaddr*)&a,sizeof(a)));}else{rec(0xfeed);rec(0xfeed);}
 name(s);zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=ip(239,255,44,29);a.sin_port=htons(48449);
 WSASetLastError(0x1234);pair(connect(s,(struct sockaddr*)&a,sizeof(a)));name(s);
 FD_ZERO(&w);FD_ZERO(&x);FD_SET(s,&w);FD_SET(s,&x);t.tv_sec=0;t.tv_usec=0;WSASetLastError(0x1234);r=select(0,0,&w,&x,&t);pair(r);rec(FD_ISSET(s,&w));rec(FD_ISSET(s,&x));
 err=0x12345678;n=4;WSASetLastError(0x1234);pair(getsockopt(s,SOL_SOCKET,SO_ERROR,(char*)&err,&n));rec(n);rec(err);
 WSASetLastError(0x1234);pair(closesocket(s));
}
void entry(void){WSADATA data;HANDLE f;DWORD written;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);oracle_results[2]=ORACLE_NONCE;WSASetLastError(0x1234);pair(WSAStartup(MAKEWORD(2,2),&data));one(0);one(1);one(2);WSASetLastError(0x1234);pair(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;
 f=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,0);if(f==INVALID_HANDLE_VALUE)ExitProcess(92);if(!WriteFile(f,(const void*)oracle_results,used*4,&written,0)||written!=used*4)ExitProcess(93);CloseHandle(f);ExitProcess(0);}
