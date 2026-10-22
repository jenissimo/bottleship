#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[64];
static DWORD count=3;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char*p=ptr;while(size--)*p++=0;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;WSAPROTOCOL_INFOA info;SOCKET source,alias,other;struct sockaddr_in address;int result,length=sizeof(address);char buffer[8];
    record(WSAStartup(MAKEWORD(2,2),&data));source=socket(AF_INET,SOCK_DGRAM,17);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(source,(struct sockaddr*)&address,sizeof(address)));record(getsockname(source,(struct sockaddr*)&address,&length));record(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));
#ifdef ORACLE_TOUCH_RESERVED
    {struct sockaddr_in ignored;int ignored_length=sizeof(ignored);result=getsockname((SOCKET)info.dwProviderReserved,(struct sockaddr*)&ignored,&ignored_length);record(result);record(result<0?WSAGetLastError():0);}
#endif
    record(WSACleanup());record(WSAStartup(MAKEWORD(2,2),&data));alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(alias!=INVALID_SOCKET);record(alias==INVALID_SOCKET?WSAGetLastError():0);
    other=socket(AF_INET,SOCK_DGRAM,17);result=bind(other,(struct sockaddr*)&address,sizeof(address));record(result);record(result<0?WSAGetLastError():0);
    if(alias!=INVALID_SOCKET){record(sendto(other,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));record(recv(alias,buffer,8,0));record(buffer[0]);record(buffer[2]);record(closesocket(alias));}
    record(closesocket(other));record(WSACleanup());finish();}
