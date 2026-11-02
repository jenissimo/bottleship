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
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static SOCKET copy(SOCKET source){WSAPROTOCOL_INFOA info;if(WSADuplicateSocketA(source,GetCurrentProcessId(),&info))return INVALID_SOCKET;
    return WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);}
static void integer_option(int type,int level,int option,int value){
    SOCKET source=socket(AF_INET,type,type==SOCK_STREAM?6:17),alias=copy(source);int original=-1,duplicate=-1,length=4,result;
    record(alias!=INVALID_SOCKET);result=setsockopt(alias,level,option,(char*)&value,4);record(result);record(result<0?WSAGetLastError():0);
    record(getsockopt(source,level,option,(char*)&original,&length));record(original);length=4;record(getsockopt(alias,level,option,(char*)&duplicate,&length));record(duplicate);
    closesocket(source);closesocket(alias);
}
void entry(void){WSADATA data;SOCKET source,alias;struct linger setting,original,duplicate;int length;u_long nonblock;char byte;DWORD wait=200;
    record(WSAStartup(MAKEWORD(2,2),&data));
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_BROADCAST,1);
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_REUSEADDR,1);
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_RCVBUF,8192);
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_SNDBUF,8192);
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_RCVTIMEO,1234);
    integer_option(SOCK_DGRAM,SOL_SOCKET,SO_SNDTIMEO,2345);
    integer_option(SOCK_STREAM,SOL_SOCKET,SO_KEEPALIVE,1);
    integer_option(SOCK_STREAM,SOL_SOCKET,SO_OOBINLINE,1);
    integer_option(SOCK_STREAM,IPPROTO_TCP,TCP_NODELAY,1);
    integer_option(SOCK_DGRAM,IPPROTO_IP,IP_TTL,17);
    integer_option(SOCK_DGRAM,IPPROTO_IP,IP_TOS,16);
    source=socket(AF_INET,SOCK_STREAM,6);alias=copy(source);setting.l_onoff=1;setting.l_linger=2;
    record(setsockopt(alias,SOL_SOCKET,SO_LINGER,(char*)&setting,sizeof(setting)));length=sizeof(original);record(getsockopt(source,SOL_SOCKET,SO_LINGER,(char*)&original,&length));record(original.l_onoff);record(original.l_linger);
    length=sizeof(duplicate);record(getsockopt(alias,SOL_SOCKET,SO_LINGER,(char*)&duplicate,&length));record(duplicate.l_onoff);record(duplicate.l_linger);closesocket(source);closesocket(alias);
    source=socket(AF_INET,SOCK_DGRAM,17);alias=copy(source);nonblock=1;record(ioctlsocket(alias,FIONBIO,&nonblock));
    /* An unbound receive has a deterministic error and cannot hang if sharing differs. */
    record(recv(source,&byte,1,0));record(WSAGetLastError());closesocket(source);closesocket(alias);
    record(WSACleanup());finish();
}
