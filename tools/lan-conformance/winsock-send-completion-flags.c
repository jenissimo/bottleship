#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_SOCKET_FLAGS
#define ORACLE_SOCKET_FLAGS 0
#endif
__declspec(dllexport) volatile DWORD oracle_results[64];static DWORD count=3,callback_count,callback_error,callback_bytes,callback_flags;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void*ptr,DWORD length){char*p=ptr;while(length--)*p++=0;}
static void CALLBACK complete(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){(void)ov;callback_count++;callback_error=error;callback_bytes=bytes;callback_flags=flags;}
static void run_case(int connected){SOCKET rx=socket(AF_INET,SOCK_DGRAM,17),tx=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,ORACLE_SOCKET_FLAGS);struct sockaddr_in address;WSABUF buffer;WSAOVERLAPPED ov;DWORD bytes=0,flags=0;int result,length=sizeof(address);char data[4]={0,0,0,0};
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);bind(rx,(struct sockaddr*)&address,sizeof(address));getsockname(rx,(struct sockaddr*)&address,&length);if(connected)connect(tx,(struct sockaddr*)&address,sizeof(address));
    clear_bytes(&ov,sizeof(ov));ov.Offset=0x11223344;buffer.buf="abc";buffer.len=3;callback_count=0;callback_error=callback_bytes=callback_flags=0x12345678;
    result=connected?WSASend(tx,&buffer,1,&bytes,0,&ov,complete):WSASendTo(tx,&buffer,1,&bytes,0,(struct sockaddr*)&address,sizeof(address),&ov,complete);record(result);record(result<0?WSAGetLastError():0);record(bytes);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(SleepEx(1000,TRUE));record(callback_count);record(callback_error);record(callback_bytes);record(callback_flags);
    result=WSAGetOverlappedResult(tx,&ov,&bytes,FALSE,&flags);record(result);record(result?0:WSAGetLastError());record(bytes);record(flags);record(recv(rx,data,4,0));record(data[0]);record(data[2]);closesocket(rx);closesocket(tx);}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));run_case(0);run_case(1);record(WSACleanup());finish();}
