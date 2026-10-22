#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void get(SOCKET socket,int level,int option){int value=0xa5a5a5a5,length=4,result;result=getsockopt(socket,level,option,(char*)&value,&length);record(result);record(result<0?WSAGetLastError():0);record(value);record(length);}
static void probe(int type,int level,int option){SOCKET socket=WSASocketA(AF_INET,type,type==SOCK_STREAM?6:17,0,0,WSA_FLAG_OVERLAPPED);int value=1,result;
    get(socket,level,option);result=setsockopt(socket,level,option,(char*)&value,4);record(result);record(result<0?WSAGetLastError():0);get(socket,level,option);
    value=0;result=setsockopt(socket,level,option,(char*)&value,1);record(result);record(result<0?WSAGetLastError():0);get(socket,level,option);closesocket(socket);}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));
    probe(SOCK_DGRAM,SOL_SOCKET,SO_BROADCAST);probe(SOCK_DGRAM,SOL_SOCKET,SO_REUSEADDR);
    probe(SOCK_STREAM,SOL_SOCKET,SO_KEEPALIVE);probe(SOCK_STREAM,IPPROTO_TCP,TCP_NODELAY);
    probe(SOCK_DGRAM,SOL_SOCKET,SO_RCVBUF);probe(SOCK_STREAM,SOL_SOCKET,SO_RCVBUF);
    probe(SOCK_DGRAM,IPPROTO_IP,IP_TTL);probe(SOCK_DGRAM,IPPROTO_IP,IP_TOS);
    record(WSACleanup());finish();}
