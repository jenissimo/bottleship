#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[1024];
static DWORD used=3,raw_used=0,raw[256],callbacks,error_out,callback_size,flags_out,same_ov,same_thread,owner;static WSAOVERLAPPED *expected;static BYTE output[131072];
static void record(DWORD n){oracle_results[used++]=n;}static void zero(void *p,DWORD n){BYTE *b=p;while(n--)*b++=0;}
static void CALLBACK completion(DWORD error,DWORD bytes,WSAOVERLAPPED *ov,DWORD flags){callbacks++;error_out=error;callback_size=bytes;flags_out=flags;same_ov=ov==expected;same_thread=owner==GetCurrentThreadId();}
static BOOL save(const char *name,const void *bytes,DWORD length){DWORD written;HANDLE f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(f==INVALID_HANDLE_VALUE)return FALSE;BOOL ok=WriteFile(f,bytes,length,&written,0)&&written==length;CloseHandle(f);return ok;}
static DWORD size_class(DWORD n){return n==0xdeadbeef||n==0xbeef?0:n!=0&&n%76==0?1:2;}
static void probe(DWORD creation,DWORD mode){
 SOCKET s=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,creation);WSAOVERLAPPED ov;HANDLE event=CreateEventA(0,TRUE,FALSE,0),port=0;DWORD *size=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE),old,got=0xfeed,flags=0xfeed,wait=0xfeed;ULONG_PTR key=0;LPOVERLAPPED returned=0;BOOL overlapped=mode!=4&&mode!=7&&mode!=8;
 zero(&ov,sizeof(ov));ov.Internal=0xfeed;ov.InternalHigh=0xbeef;ov.Offset=0xaaaa;ov.hEvent=mode==2?0:mode==3?(HANDLE)((ULONG_PTR)event|1):event;*size=0xdeadbeef;
 if(mode==2||mode==3)port=CreateIoCompletionPort((HANDLE)s,0,42,0);if(mode==6||mode==8)VirtualProtect(size,4096,PAGE_READONLY,&old);
 callbacks=error_out=callback_size=flags_out=same_ov=same_thread=0;owner=GetCurrentThreadId();expected=&ov;record(creation);record(mode);SetLastError(0x1234);
 int value=WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,mode==9?(void*)1:output,sizeof(output),mode==5||mode==7?0:size,overlapped?&ov:0,mode==1?completion:0);DWORD error=GetLastError();record(value);record(error);
 raw[raw_used++]=creation;raw[raw_used++]=mode;raw[raw_used++]=ov.Internal;raw[raw_used++]=ov.InternalHigh;raw[raw_used++]=*size;
 if(overlapped&&mode!=2)wait=WaitForSingleObject(event,100);DWORD slept=SleepEx(25,TRUE);record(wait);record(slept);record(callbacks);record(error_out);record(size_class(callback_size));record(flags_out);record(same_ov);record(same_thread);
 if(port){SetLastError(0x2345);record(GetQueuedCompletionStatus(port,&got,&key,&returned,100));record(GetLastError());record(size_class(got));record(key);record(returned==&ov);}else for(DWORD i=0;i<5;i++)record(0xfeed);
 record(ov.Internal);record(size_class(ov.InternalHigh));record(ov.Offset);record(size_class(*size));
 if(overlapped){SetLastError(0x3456);record(WSAGetOverlappedResult(s,&ov,&got,FALSE,&flags));record(WSAGetLastError());record(size_class(got));record(flags);}else for(DWORD i=0;i<4;i++)record(0xfeed);
 VirtualProtect(size,4096,PAGE_READWRITE,&old);VirtualFree(size,0,MEM_RELEASE);if(port)CloseHandle(port);CloseHandle(event);closesocket(s);
}
void entry(void){WSADATA data;DWORD creation,mode;record(WSAStartup(MAKEWORD(2,2),&data));for(creation=0;creation<2;creation++)for(mode=0;mode<10;mode++)probe(creation,mode);record(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;if(!save("topology-ioctl-raw.bin",raw,raw_used*4)||!save("lan-oracle.bin",(const void*)oracle_results,used*4))ExitProcess(1);ExitProcess(0);}
