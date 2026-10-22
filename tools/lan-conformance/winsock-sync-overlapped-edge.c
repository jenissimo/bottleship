#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0600
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[160];static DWORD count=3,callbacks,sender_delay=50;static SOCKET rx,tx;static struct sockaddr_in address;static WSAOVERLAPPED ov;static int cancel_result,cancel_error;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char*p=ptr;while(size--)*p++=0;}
static DWORD WINAPI sender(LPVOID ignored){(void)ignored;Sleep(sender_delay);sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address));return 0;}
static DWORD WINAPI cancel_thread(LPVOID ignored){(void)ignored;Sleep(50);cancel_result=CancelIoEx((HANDLE)rx,&ov);cancel_error=cancel_result?0:GetLastError();return 0;}
static void CALLBACK complete(DWORD error,DWORD bytes,LPWSAOVERLAPPED overlapped,DWORD flags){(void)error;(void)bytes;(void)overlapped;(void)flags;callbacks++;}
static void setup(void){int size=sizeof(address);DWORD timeout=1000;rx=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,0);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);bind(rx,(struct sockaddr*)&address,sizeof(address));getsockname(rx,(struct sockaddr*)&address,&size);setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);clear_bytes(&ov,sizeof(ov));ov.hEvent=WSACreateEvent();ov.Offset=0x11223344;}
static void observation(int result,DWORD bytes,DWORD flags){record(result);record(result<0?WSAGetLastError():0);record(bytes);record(flags);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(WaitForSingleObject(ov.hEvent,0));}
static void close_case(void){closesocket(rx);WSACloseEvent(ov.hEvent);}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;WSABUF buffer;char bytes_buffer[8];DWORD bytes,flags,timeout,started;int result;u_long nonblock;HANDLE thread,fallback;
    record(WSAStartup(MAKEWORD(2,2),&data));tx=socket(AF_INET,SOCK_DGRAM,17);buffer.buf=bytes_buffer;buffer.len=8;
    setup();nonblock=1;ioctlsocket(rx,FIONBIO,&nonblock);bytes=0;flags=0;thread=CreateThread(0,0,sender,0,0,0);result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,0);observation(result,bytes,flags);WaitForSingleObject(thread,1000);CloseHandle(thread);result=WSAGetOverlappedResult(rx,&ov,&bytes,FALSE,&flags);record(result);record(result?0:WSAGetLastError());record(bytes);nonblock=0;ioctlsocket(rx,FIONBIO,&nonblock);close_case();
    setup();timeout=40;setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);bytes=0;flags=0;sender_delay=200;fallback=CreateThread(0,0,sender,0,0,0);started=GetTickCount();result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,0);record(GetTickCount()-started>=100);observation(result,bytes,flags);result=WSAGetOverlappedResult(rx,&ov,&bytes,FALSE,&flags);record(result);record(result?0:WSAGetLastError());record(bytes);WaitForSingleObject(fallback,1000);CloseHandle(fallback);close_case();
    setup();bytes=0;flags=0;thread=CreateThread(0,0,cancel_thread,0,0,0);fallback=CreateThread(0,0,sender,0,0,0);result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,0);observation(result,bytes,flags);WaitForSingleObject(thread,1000);CloseHandle(thread);record(cancel_result);record(cancel_error);WaitForSingleObject(fallback,1000);CloseHandle(fallback);close_case();
    setup();timeout=40;setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);bytes=0;flags=0;fallback=CreateThread(0,0,sender,0,0,0);started=GetTickCount();result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,complete);record(GetTickCount()-started>=100);observation(result,bytes,flags);record(SleepEx(200,TRUE));record(callbacks);WaitForSingleObject(fallback,1000);CloseHandle(fallback);close_case();closesocket(tx);record(WSACleanup());finish();
}
