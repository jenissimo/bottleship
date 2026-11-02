#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_SOCKET_FLAGS
#define ORACLE_SOCKET_FLAGS 0
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3,callbacks;static SOCKET tx;static struct sockaddr_in address;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char *p=ptr;while(size--)*p++=0;}
static DWORD WINAPI sender(LPVOID ignored){(void)ignored;Sleep(50);sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address));return 0;}
static void CALLBACK complete(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){(void)error;(void)bytes;(void)ov;(void)flags;callbacks++;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static SOCKET bind_sync(void){SOCKET rx=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,ORACLE_SOCKET_FLAGS);int length=sizeof(address);DWORD timeout=1000;
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);bind(rx,(struct sockaddr*)&address,sizeof(address));getsockname(rx,(struct sockaddr*)&address,&length);setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);return rx;}
void entry(void){WSADATA startup;SOCKET rx,alias;WSAPROTOCOL_INFOA info;WSAOVERLAPPED ov;WSABUF buffer;WSAEVENT event;HANDLE thread;DWORD bytes,flags;int result;char data[8];
    record(WSAStartup(MAKEWORD(2,2),&startup));tx=socket(AF_INET,SOCK_DGRAM,17);rx=bind_sync();record(rx!=INVALID_SOCKET);event=WSACreateEvent();clear_bytes(&ov,sizeof(ov));ov.hEvent=event;ov.Offset=0x11223344;buffer.buf=data;buffer.len=8;bytes=0;flags=0;thread=CreateThread(0,0,sender,0,0,0);
    result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,0);record(result);record(result<0?WSAGetLastError():0);record(bytes);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(WaitForSingleObject(event,0));
    WaitForSingleObject(thread,1000);CloseHandle(thread);record(WSAGetOverlappedResult(rx,&ov,&bytes,TRUE,&flags));record(bytes);record(flags);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(WaitForSingleObject(event,0));record(data[0]);record(data[2]);WSACloseEvent(event);closesocket(rx);
    rx=bind_sync();clear_bytes(&ov,sizeof(ov));bytes=0;flags=0;thread=CreateThread(0,0,sender,0,0,0);result=WSARecv(rx,&buffer,1,&bytes,&flags,&ov,complete);record(result);record(result<0?WSAGetLastError():0);record(bytes);record(ov.Internal);record(ov.InternalHigh);record(SleepEx(200,TRUE));record(callbacks);record(data[0]);record(data[2]);WaitForSingleObject(thread,1000);CloseHandle(thread);closesocket(rx);
    rx=bind_sync();record(WSADuplicateSocketA(rx,GetCurrentProcessId(),&info));alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(alias!=INVALID_SOCKET);sendto(tx,"def",3,0,(struct sockaddr*)&address,sizeof(address));bytes=0;result=ReadFile((HANDLE)alias,data,8,&bytes,0);record(result);record(result?0:GetLastError());record(bytes);if(result){record(data[0]);record(data[2]);}closesocket(alias);closesocket(rx);closesocket(tx);record(WSACleanup());finish();
}
