#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void answer(int value){record(value);record(value<0?WSAGetLastError():0);}
static void read_option(SOCKET socket,int level,int option,int capacity){DWORD value=0xa5a5a5a5;int length=capacity,result=getsockopt(socket,level,option,(char*)&value,&length);answer(result);record(value);record(length);}
static void probe(int family,int type,int option){
    SOCKET source=socket(family,type,type==SOCK_STREAM?6:17),alias;WSAPROTOCOL_INFOA info;DWORD value;int level=option==TCP_NODELAY?IPPROTO_TCP:SOL_SOCKET;
    record(family);record(type);record(option);record(source!=INVALID_SOCKET);
    answer(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(alias!=INVALID_SOCKET);
    read_option(source,level,option,4);read_option(alias,level,option,1);
    value=1;answer(setsockopt(alias,level,option,(const char*)&value,1));read_option(source,level,option,4);read_option(alias,level,option,4);
    value=0x100;answer(setsockopt(source,level,option,(const char*)&value,4));read_option(source,level,option,1);read_option(alias,level,option,1);
    value=1;answer(setsockopt(source,level,option,(const char*)&value,0));read_option(source,level,option,4);
    answer(setsockopt(source,level,option,0,1));read_option(source,level,option,4);read_option(source,level,option,0);
    answer(closesocket(source));answer(closesocket(alias));
}
static void inheritance(int option){
    SOCKET listener=socket(AF_INET,SOCK_STREAM,6),client=socket(AF_INET,SOCK_STREAM,6),accepted;struct sockaddr_in address;DWORD value=1;int length=sizeof(address),level=option==TCP_NODELAY?IPPROTO_TCP:SOL_SOCKET;char*p=(char*)&address;DWORD i;
    for(i=0;i<sizeof(address);i++)p[i]=0;address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(option);answer(setsockopt(listener,level,option,(const char*)&value,1));answer(bind(listener,(struct sockaddr*)&address,sizeof(address)));answer(getsockname(listener,(struct sockaddr*)&address,&length));answer(listen(listener,1));answer(connect(client,(struct sockaddr*)&address,sizeof(address)));accepted=accept(listener,0,0);record(accepted!=INVALID_SOCKET);
    read_option(accepted,level,option,4);read_option(client,level,option,4);closesocket(accepted);closesocket(client);closesocket(listener);
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;record(WSAStartup(MAKEWORD(2,2),&data));probe(AF_INET,SOCK_STREAM,SO_KEEPALIVE);probe(AF_INET,SOCK_STREAM,TCP_NODELAY);probe(AF_INET6,SOCK_STREAM,SO_KEEPALIVE);probe(AF_INET6,SOCK_STREAM,TCP_NODELAY);probe(AF_INET,SOCK_DGRAM,SO_KEEPALIVE);probe(AF_INET,SOCK_DGRAM,TCP_NODELAY);inheritance(SO_KEEPALIVE);inheritance(TCP_NODELAY);record(WSACleanup());finish();}
