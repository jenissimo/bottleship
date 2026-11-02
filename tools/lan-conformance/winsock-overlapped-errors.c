#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[768];static DWORD count=3,callback_count,callback_error,callback_bytes;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void*ptr,DWORD length){char*p=ptr;while(length--)*p++=0;}
static void CALLBACK complete(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){(void)ov;(void)flags;callback_count++;callback_error=error;callback_bytes=bytes;}
static void run_case(int state,int write,int mode){
    SOCKET socket,listener=INVALID_SOCKET,peer=INVALID_SOCKET;struct sockaddr_in address;struct linger abortive;WSABUF buffer;WSAOVERLAPPED ov;DWORD bytes=0xabcdef01,flags=0;int result,error,length=sizeof(address);HANDLE event=CreateEventA(0,TRUE,TRUE,0),port=0;char data[4]={1,2,3,4};DWORD packet_bytes;ULONG_PTR key;LPOVERLAPPED completed;
    socket=WSASocketA(AF_INET,state==3?SOCK_DGRAM:SOCK_STREAM,state==3?17:6,0,0,WSA_FLAG_OVERLAPPED);
    if(state==1||state==2){
        listener=WSASocketA(AF_INET,SOCK_STREAM,6,0,0,WSA_FLAG_OVERLAPPED);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);bind(listener,(struct sockaddr*)&address,sizeof(address));getsockname(listener,(struct sockaddr*)&address,&length);listen(listener,1);connect(socket,(struct sockaddr*)&address,sizeof(address));peer=accept(listener,0,0);
        if(state==1){abortive.l_onoff=1;abortive.l_linger=0;setsockopt(peer,SOL_SOCKET,SO_LINGER,(char*)&abortive,4);closesocket(peer);peer=INVALID_SOCKET;Sleep(50);}else shutdown(socket,write?SD_SEND:SD_RECEIVE);
    }
    if(mode==2)port=CreateIoCompletionPort((HANDLE)socket,0,42,1);
    clear_bytes(&ov,sizeof(ov));ov.Internal=0x11223344;ov.InternalHigh=0x55667788;ov.Offset=0x21314151;ov.OffsetHigh=0x61718191;if(mode!=2)ov.hEvent=event;
    buffer.buf=data;buffer.len=4;callback_count=0;callback_error=callback_bytes=0x12345678;
    result=write?WSASend(socket,&buffer,1,&bytes,0,&ov,mode==1?complete:0):WSARecv(socket,&buffer,1,&bytes,&flags,&ov,mode==1?complete:0);error=result<0?WSAGetLastError():0;
    record(result);record(error);record(bytes);record(flags);record(ov.Internal);record(ov.InternalHigh);record(ov.Offset);record(ov.OffsetHigh);record(WaitForSingleObject(event,0));record(SleepEx(20,TRUE));record(callback_count);record(callback_error);record(callback_bytes);
    if(mode==2){packet_bytes=0x11223344;key=0x55667788;completed=(LPOVERLAPPED)0x12345678;result=GetQueuedCompletionStatus(port,&packet_bytes,&key,&completed,0);record(result);record(result?0:GetLastError());record(packet_bytes);record(key);record(completed==&ov?1:completed==0?0:2);}
    closesocket(socket);if(peer!=INVALID_SOCKET)closesocket(peer);if(listener!=INVALID_SOCKET)closesocket(listener);CloseHandle(event);if(port)CloseHandle(port);
}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
void entry(void){WSADATA data;int state,write,mode;record(WSAStartup(MAKEWORD(2,2),&data));for(state=0;state<4;state++)for(write=0;write<2;write++)for(mode=0;mode<3;mode++)run_case(state,write,mode);record(WSACleanup());finish();}
