#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static void outcome(int result){record(result);record(result<0?WSAGetLastError():0);}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static void probe(DWORD mode){
    WSADATA data;WSAPROTOCOL_INFOA info;SOCKET source,peer,raw,alias,other;
    struct sockaddr_in address,remote,check;int length,result;DWORD bytes,timeout=200;char buffer[8];
    record(mode);record(WSAStartup(MAKEWORD(2,2),&data));
    source=WSASocketA(AF_INET,SOCK_DGRAM,IPPROTO_UDP,0,0,0);
    peer=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);record(source!=INVALID_SOCKET&&peer!=INVALID_SOCKET);
    zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);remote=address;
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(bind(peer,(struct sockaddr*)&remote,sizeof(remote)));
    length=sizeof(address);outcome(getsockname(source,(struct sockaddr*)&address,&length));length=sizeof(remote);outcome(getsockname(peer,(struct sockaddr*)&remote,&length));
    outcome(connect(source,(struct sockaddr*)&remote,sizeof(remote)));outcome(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;
    zero(buffer,sizeof(buffer));bytes=0xfeed;
    if(mode==0){record(GetFileType((HANDLE)raw));}
    else if(mode==1){
        outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));
        SetLastError(0);result=ReadFile((HANDLE)raw,buffer,sizeof(buffer),&bytes,0);record(result);record(result?0:GetLastError());record(bytes);record(buffer[0]);record(buffer[2]);
    }else if(mode==2){
        SetLastError(0);result=WriteFile((HANDLE)raw,"def",3,&bytes,0);record(result);record(result?0:GetLastError());record(bytes);
        setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);outcome(recv(peer,buffer,sizeof(buffer),0));record(buffer[0]);record(buffer[2]);
    }else{length=sizeof(check);outcome(getsockname(raw,(struct sockaddr*)&check,&length));}
    record(WSACleanup());record(WSAStartup(MAKEWORD(2,2),&data));
    alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,0);record(alias!=INVALID_SOCKET);record(alias==INVALID_SOCKET?WSAGetLastError():0);
    zero(&check,sizeof(check));length=sizeof(check);result=getsockname(alias,(struct sockaddr*)&check,&length);outcome(result);record(result==0&&check.sin_port==address.sin_port);
    other=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);outcome(bind(other,(struct sockaddr*)&address,sizeof(address)));
    outcome(closesocket(alias));outcome(closesocket(other));record(WSACleanup());
}
void entry(void){probe(0);probe(1);probe(2);finish();}
