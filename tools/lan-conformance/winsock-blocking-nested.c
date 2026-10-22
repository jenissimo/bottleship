#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3;static SOCKET rx,tx;static struct sockaddr_in address;static int called,observations[64],used;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void pair(int value){observations[used++]=value;observations[used++]=WSAGetLastError();}
static void clear_bytes(void *value,DWORD size){unsigned char *p=value;while(size--)*p++=0;}
static BOOL WINAPI hook(void){SOCKET created;WSAEVENT event;struct hostent *host;struct addrinfo *list=0;WSAOVERLAPPED ov;char name[128];int value=0,size=4,r;u_long available;DWORD bytes=0,flags=0;
    if(called++)return FALSE;
    WSASetLastError(12345);created=socket(AF_INET,SOCK_DGRAM,17);pair(created!=INVALID_SOCKET);if(created!=INVALID_SOCKET)closesocket(created);
    WSASetLastError(12345);host=gethostbyname("localhost");pair(host!=0);
    WSASetLastError(12345);r=gethostname(name,sizeof(name));pair(r);
    WSASetLastError(12345);r=getsockopt(rx,SOL_SOCKET,SO_TYPE,(char*)&value,&size);pair(r);
    WSASetLastError(12345);r=ioctlsocket(rx,FIONREAD,&available);pair(r);
    WSASetLastError(12345);event=WSACreateEvent();pair(event!=WSA_INVALID_EVENT);if(event!=WSA_INVALID_EVENT){WSASetLastError(12345);r=WSASetEvent(event);pair(r);WSASetLastError(12345);r=WSAResetEvent(event);pair(r);WSASetLastError(12345);r=WSACloseEvent(event);pair(r);}
    WSASetLastError(12345);r=getaddrinfo("localhost",0,0,&list);pair(r);if(list)freeaddrinfo(list);
    clear_bytes(&ov,sizeof(ov));WSASetLastError(12345);r=WSAGetOverlappedResult(rx,&ov,&bytes,FALSE,&flags);pair(r);
    WSASetLastError(12345);r=WSAUnhookBlockingHook();pair(r);
    return FALSE;
}
static DWORD WINAPI sender(LPVOID ignored){(void)ignored;Sleep(50);sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address));return 0;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;HANDLE thread;DWORD timeout=1000;int size,r,i;char buffer[4];
    record(WSAStartup(MAKEWORD(1,1),&data));rx=socket(AF_INET,SOCK_DGRAM,17);tx=socket(AF_INET,SOCK_DGRAM,17);
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);record(bind(rx,(struct sockaddr*)&address,sizeof(address)));size=sizeof(address);getsockname(rx,(struct sockaddr*)&address,&size);setsockopt(rx,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);
    record(WSASetBlockingHook((FARPROC)hook)!=0);thread=CreateThread(0,0,sender,0,0,0);r=recv(rx,buffer,3,0);record(r);record(r<0?WSAGetLastError():0);record(called>0);record(used);for(i=0;i<used;i++)record(observations[i]);
    WaitForSingleObject(thread,1000);CloseHandle(thread);closesocket(rx);closesocket(tx);record(WSACleanup());finish();
}
