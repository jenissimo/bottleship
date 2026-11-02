#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <stddef.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define S2(x) #x
#define S(x) S2(x)
#define MAPNAME "Local\\BottleShipTopology-" S(ORACLE_NONCE)
#define CAPACITY 131072
__declspec(dllexport) volatile DWORD oracle_results[1024];
static DWORD count=3,raw_count=0,raw_results[1024];static volatile DWORD *shared;
static BYTE *buffer_page,*size_page;static DWORD initial_size,api,output_offset;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *pointer,DWORD length){BYTE *p=pointer;while(length--)*p++=0;}
static void copyback(void){DWORD old,value;VirtualProtect(buffer_page,CAPACITY+8192,PAGE_READWRITE,&old);VirtualProtect(size_page,4096,PAGE_READWRITE,&old);value=*(DWORD*)size_page;shared[10]=value;shared[8]=value==initial_size?0:value==0?1:value<1048576?2:3;shared[9]=buffer_page[output_offset]!=0xa5;}
static LONG WINAPI fault(PEXCEPTION_POINTERS info){shared[3]=info->ExceptionRecord->ExceptionCode;copyback();ExitProcess(0);return EXCEPTION_CONTINUE_SEARCH;}
static void child(DWORD id){
 HANDLE mapping=OpenFileMappingA(FILE_MAP_ALL_ACCESS,FALSE,MAPNAME);DWORD mode=id%16,protect,index;ULONG *size_pointer;void *output;WSADATA startup;SOCKET socket_handle=INVALID_SOCKET;DWORD status;
 api=id/16;if(!mapping)ExitProcess(20);shared=(volatile DWORD*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,64);if(!shared)ExitProcess(21);
 SetErrorMode(SEM_NOGPFAULTERRORBOX|SEM_FAILCRITICALERRORS);SetUnhandledExceptionFilter(fault);
 for(index=0;index<16;index++)shared[index]=0xfeed;shared[0]=id;shared[1]=api;shared[2]=mode;shared[3]=0;shared[4]=1;
 buffer_page=VirtualAlloc(0,CAPACITY+8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);size_page=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);if(!buffer_page||!size_page)ExitProcess(22);
 for(index=0;index<CAPACITY+8192;index++)buffer_page[index]=0xa5;
 initial_size=api?CAPACITY:0xdeadbeef;if(mode==1)initial_size=0;else if(mode==2)initial_size=1;else if(mode==3)initial_size=75;else if(mode==4)initial_size=76;
 *(ULONG*)size_page=initial_size;size_pointer=(ULONG*)size_page;output=buffer_page;output_offset=mode==13?4094:0;
 if(mode==5)output=0;if(mode==6)output=(void*)1;
 if(mode==7)VirtualProtect(buffer_page,CAPACITY+8192,PAGE_READONLY,&protect);
 if(mode==8)VirtualProtect(buffer_page,CAPACITY+8192,PAGE_NOACCESS,&protect);
 if(mode==9)size_pointer=0;if(mode==10)size_pointer=(ULONG*)1;
 if(mode==11)VirtualProtect(size_page,4096,PAGE_READONLY,&protect);
 if(mode==12)VirtualProtect(size_page,4096,PAGE_NOACCESS,&protect);
 if(mode==13){output=buffer_page+4094;VirtualProtect(buffer_page+4096,4096,PAGE_READONLY,&protect);}
 if(api==0){if(WSAStartup(MAKEWORD(2,2),&startup))ExitProcess(23);socket_handle=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);if(socket_handle==INVALID_SOCKET)ExitProcess(24);if(mode==15)WSACleanup();}
 shared[4]=2;SetLastError(0x1234);
 if(api==0){DWORD capacity=mode==1?0:mode==2?1:mode==3?75:mode==4?76:CAPACITY;status=WSAIoctl(socket_handle,SIO_GET_INTERFACE_LIST,mode==14?(void*)1:0,mode==14?1:0,output,capacity,size_pointer,0,0);}
 else if(api==1)status=GetAdaptersInfo((IP_ADAPTER_INFO*)output,size_pointer);
 else status=GetAdaptersAddresses(AF_UNSPEC,0,mode==14?(void*)1:0,(IP_ADAPTER_ADDRESSES*)output,size_pointer);
 shared[5]=status;shared[6]=GetLastError();shared[4]=3;copyback();shared[4]=4;
 if(api==0&&mode!=15){closesocket(socket_handle);WSACleanup();}VirtualFree(buffer_page,0,MEM_RELEASE);VirtualFree(size_page,0,MEM_RELEASE);ExitProcess(0);
}
static char *append(char *out,const char *text){while(*text)*out++=*text++;return out;}
static char *decimal(char *out,DWORD value){char digits[16];DWORD n=0;do{digits[n++]='0'+value%10;value/=10;}while(value);while(n)*out++=digits[--n];return out;}
static BOOL save(const char *name,const void *data,DWORD bytes){DWORD written;HANDLE file=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file==INVALID_HANDLE_VALUE)return FALSE;BOOL result=WriteFile(file,data,bytes,&written,0)&&written==bytes;CloseHandle(file);return result;}
void entry(void){
 char *line=GetCommandLineA();while(*line){if(*line++=='#'){DWORD id=0;while(*line>='0'&&*line<='9')id=id*10+*line++-'0';child(id);}}
 HANDLE mapping=CreateFileMappingA(INVALID_HANDLE_VALUE,0,PAGE_READWRITE,0,64,MAPNAME);DWORD id,index;char executable[1024],command[1100];STARTUPINFOA startup;PROCESS_INFORMATION process;
 shared=mapping?(volatile DWORD*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,64):0;if(!shared)ExitProcess(30);GetModuleFileNameA(0,executable,sizeof(executable));SetErrorMode(SEM_NOGPFAULTERRORBOX|SEM_FAILCRITICALERRORS);
 record(sizeof(INTERFACE_INFO));record(offsetof(INTERFACE_INFO,iiAddress));record(offsetof(INTERFACE_INFO,iiBroadcastAddress));record(offsetof(INTERFACE_INFO,iiNetmask));
 record(sizeof(IP_ADAPTER_INFO));record(offsetof(IP_ADAPTER_INFO,AdapterName));record(offsetof(IP_ADAPTER_INFO,IpAddressList));record(offsetof(IP_ADAPTER_INFO,GatewayList));record(offsetof(IP_ADAPTER_INFO,LeaseObtained));
 record(sizeof(IP_ADDR_STRING));record(sizeof(IP_ADAPTER_ADDRESSES));record(offsetof(IP_ADAPTER_ADDRESSES,FirstUnicastAddress));record(offsetof(IP_ADAPTER_ADDRESSES,FirstPrefix));record(sizeof(IP_ADAPTER_UNICAST_ADDRESS));record(sizeof(IP_ADAPTER_PREFIX));
 for(id=0;id<48;id++){
  for(index=0;index<16;index++)shared[index]=0xdeadbeef;
  char *p=append(command,"\"");p=append(p,executable);p=append(p,"\" #");p=decimal(p,id);*p=0;zero(&startup,sizeof(startup));startup.cb=sizeof(startup);zero(&process,sizeof(process));
  if(!CreateProcessA(executable,command,0,0,FALSE,CREATE_NO_WINDOW,0,0,&startup,&process))ExitProcess(31);
  DWORD waited=WaitForSingleObject(process.hProcess,3000),exit_code=0;if(waited!=WAIT_OBJECT_0){TerminateProcess(process.hProcess,32);WaitForSingleObject(process.hProcess,1000);}GetExitCodeProcess(process.hProcess,&exit_code);record(waited);record(exit_code);
  for(index=0;index<10;index++)record(shared[index]);for(index=0;index<11;index++)raw_results[raw_count++]=shared[index];
  CloseHandle(process.hThread);CloseHandle(process.hProcess);if(waited!=WAIT_OBJECT_0)ExitProcess(33);
 }
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 if(!save("topology-pointer-raw.bin",raw_results,raw_count*4)||!save("lan-oracle.bin",(const void*)oracle_results,count*4))ExitProcess(34);
 UnmapViewOfFile((const void*)shared);CloseHandle(mapping);ExitProcess(0);
}
