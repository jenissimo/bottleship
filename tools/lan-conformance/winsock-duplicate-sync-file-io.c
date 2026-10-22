#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[96];static DWORD count=3;
static SOCKET raw;static HANDLE entered;static volatile DWORD worker_value,worker_error,worker_bytes;static char buffer[8];
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void result(int value){record(value);record(value<0?WSAGetLastError():0);}
static DWORD WINAPI reader(void*unused){DWORD bytes=0xfeed;BOOL value;(void)unused;SetEvent(entered);SetLastError(0);value=ReadFile((HANDLE)raw,buffer,sizeof(buffer),&bytes,0);worker_value=value;worker_error=value?0:GetLastError();worker_bytes=bytes;return 0;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){
    WSADATA data;WSAPROTOCOL_INFOA info;SOCKET source,peer,alias;struct sockaddr_in address;int length=sizeof(address);HANDLE thread;DWORD waited;
    record(WSAStartup(MAKEWORD(2,2),&data));source=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,0);zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    result(bind(source,(struct sockaddr*)&address,sizeof(address)));result(getsockname(source,(struct sockaddr*)&address,&length));result(WSADuplicateSocketA(source,GetCurrentProcessId(),&info));raw=(SOCKET)info.dwProviderReserved;
    entered=CreateEventA(0,TRUE,FALSE,0);thread=CreateThread(0,0,reader,0,0,0);record(thread!=0);record(WaitForSingleObject(entered,1000));Sleep(30);record(WaitForSingleObject(thread,0));
    record(WSACleanup());record(WSAStartup(MAKEWORD(2,2),&data));peer=socket(AF_INET,SOCK_DGRAM,17);result(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));
    waited=WaitForSingleObject(thread,1000);record(waited);record(worker_value);record(worker_error);record(worker_bytes);record(buffer[0]);record(buffer[2]);
    if(waited==WAIT_TIMEOUT){CancelIoEx((HANDLE)raw,0);WaitForSingleObject(thread,1000);}
    alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,0);record(alias!=INVALID_SOCKET);record(alias==INVALID_SOCKET?WSAGetLastError():0);result(closesocket(alias));result(closesocket(peer));record(WSACleanup());CloseHandle(thread);CloseHandle(entered);finish();
}
