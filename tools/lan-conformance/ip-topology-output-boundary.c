#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
static int WSAAPI boundaryIoctl(SOCKET,DWORD,void*,DWORD,void*,DWORD,DWORD*,WSAOVERLAPPED*,LPWSAOVERLAPPED_COMPLETION_ROUTINE);
#define WSAIoctl boundaryIoctl
#include "ip-topology-pointers.c"
#undef WSAIoctl
static int WSAAPI boundaryIoctl(SOCKET s,DWORD code,void *input,DWORD input_size,void *output,DWORD output_size,DWORD *returned,WSAOVERLAPPED *ov,LPWSAOVERLAPPED_COMPLETION_ROUTINE routine){
 DWORD old;
 // Mode0 has an inaccessible capacity tail after many complete interface entries.
 if(shared[2]==0)VirtualProtect(buffer_page+8192,4096,PAGE_READONLY,&old);
 // Mode13 has four writable bytes before the read-only page instead of two.
 if(shared[2]==13)output=(BYTE*)output-2;
 return WSAIoctl(s,code,input,input_size,output,output_size,returned,ov,routine);
}
