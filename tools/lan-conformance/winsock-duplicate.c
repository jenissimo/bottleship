#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
/* Record provider sharing contracts with the exact same executable on Windows and the guest. */
__declspec(dllexport) volatile DWORD oracle_results[160];
static DWORD count=3;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char *p=ptr;while(size--)*p++=0;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static int option(SOCKET socket,int name){int value=-17,length=4;int result=getsockopt(socket,SOL_SOCKET,name,(char*)&value,&length);record(result);return value;}
void entry(void){
    WSADATA startup;SOCKET original,alias,again,tx,probe,listener,client,server,stream,queued;
    struct sockaddr_in address;WSAPROTOCOL_INFOA info;WSAPROTOCOL_INFOW wide;int size,value,r;u_long nonblocking;char bytes[16];DWORD timeout=1000;
    clear_bytes(&info,sizeof(info));clear_bytes(&wide,sizeof(wide));record(WSAStartup(MAKEWORD(2,2),&startup));
    original=socket(AF_INET,SOCK_DGRAM,17);tx=socket(AF_INET,SOCK_DGRAM,17);
    clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    outcome(bind(original,(struct sockaddr*)&address,sizeof(address)));size=sizeof(address);getsockname(original,(struct sockaddr*)&address,&size);
    outcome(WSADuplicateSocketA(original,GetCurrentProcessId(),&info));record(info.iAddressFamily);record(info.iSocketType);record(info.iProtocol);
    alias=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(alias!=INVALID_SOCKET);record(alias!=original);
    if(alias==INVALID_SOCKET){record(WSAGetLastError());finish();}
    setsockopt(alias,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);
    value=1;outcome(setsockopt(alias,SOL_SOCKET,SO_BROADCAST,(char*)&value,4));record(option(alias,SO_BROADCAST));record(option(original,SO_BROADCAST));
    outcome(sendto(tx,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));
    clear_bytes(bytes,sizeof(bytes));outcome(recv(original,bytes,3,MSG_PEEK));record(bytes[0]);record(bytes[2]);
    clear_bytes(bytes,sizeof(bytes));outcome(recv(alias,bytes,3,0));record(bytes[0]);record(bytes[2]);
    nonblocking=1;outcome(ioctlsocket(alias,FIONBIO,&nonblocking));outcome(recv(original,bytes,3,0));
    nonblocking=0;outcome(ioctlsocket(original,FIONBIO,&nonblocking));
    again=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(again!=INVALID_SOCKET);record(again==alias);record(again==INVALID_SOCKET?WSAGetLastError():0);if(again!=INVALID_SOCKET&&again!=alias)closesocket(again);
    outcome(WSADuplicateSocketW(alias,GetCurrentProcessId(),&wide));record(wide.iAddressFamily);record(wide.iSocketType);record(wide.iProtocol);
    again=WSASocketW(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&wide,0,WSA_FLAG_OVERLAPPED);record(again!=INVALID_SOCKET);if(again!=INVALID_SOCKET)closesocket(again);
    outcome(WSADuplicateSocketA(alias,0,&info));
    outcome(closesocket(original));probe=socket(AF_INET,SOCK_DGRAM,17);outcome(bind(probe,(struct sockaddr*)&address,sizeof(address)));closesocket(probe);
    outcome(sendto(tx,"def",3,0,(struct sockaddr*)&address,sizeof(address)));clear_bytes(bytes,sizeof(bytes));outcome(recv(alias,bytes,3,0));record(bytes[0]);record(bytes[2]);
    outcome(closesocket(alias));probe=socket(AF_INET,SOCK_DGRAM,17);outcome(bind(probe,(struct sockaddr*)&address,sizeof(address)));closesocket(probe);closesocket(tx);
    listener=socket(AF_INET,SOCK_STREAM,6);address.sin_port=0;outcome(bind(listener,(struct sockaddr*)&address,sizeof(address)));size=sizeof(address);getsockname(listener,(struct sockaddr*)&address,&size);listen(listener,4);
    client=socket(AF_INET,SOCK_STREAM,6);outcome(connect(client,(struct sockaddr*)&address,sizeof(address)));server=accept(listener,0,0);
    outcome(WSADuplicateSocketA(server,GetCurrentProcessId(),&info));stream=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(stream!=INVALID_SOCKET);
    if(stream==INVALID_SOCKET)finish();setsockopt(server,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);
    outcome(send(client,"ghi",3,0));clear_bytes(bytes,sizeof(bytes));outcome(recv(server,bytes,1,0));record(bytes[0]);outcome(recv(stream,bytes+1,2,MSG_WAITALL));record(bytes[1]);record(bytes[2]);
    outcome(closesocket(server));outcome(send(stream,"j",1,0));outcome(recv(client,bytes,1,0));record(bytes[0]);
    outcome(shutdown(stream,SD_SEND));outcome(recv(client,bytes,1,0));outcome(send(stream,"k",1,0));closesocket(stream);closesocket(client);
    outcome(WSADuplicateSocketA(listener,GetCurrentProcessId(),&info));queued=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);record(queued!=INVALID_SOCKET);
    if(queued==INVALID_SOCKET)finish();outcome(closesocket(listener));client=socket(AF_INET,SOCK_STREAM,6);outcome(connect(client,(struct sockaddr*)&address,sizeof(address)));server=accept(queued,0,0);record(server!=INVALID_SOCKET);
    closesocket(server);closesocket(client);closesocket(queued);record(WSACleanup());finish();
}
