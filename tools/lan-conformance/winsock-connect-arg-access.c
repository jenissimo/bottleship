#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define STRING2(x) #x
#define STRING(x) STRING2(x)
#define MAPNAME "Local\\BottleShipWSAArgs-" STRING(ORACLE_NONCE)
__declspec(dllexport) volatile DWORD oracle_results[1024];
static volatile DWORD *shared;
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static void zero(void *ptr,DWORD size){BYTE *p=ptr;while(size--)*p++=0;}
static LONG WINAPI fault(PEXCEPTION_POINTERS info){shared[3]=info->ExceptionRecord->ExceptionCode;ExitProcess(0);return EXCEPTION_CONTINUE_SEARCH;}
static void child(DWORD id){
    HANDLE mapping=OpenFileMappingA(FILE_MAP_ALL_ACCESS,FALSE,MAPNAME);WSADATA wsa;DWORD protect,mode=id%16;
    struct sockaddr_storage address,local;int family=id/16>=2?AF_INET6:AF_INET,type=(id/16)&1?SOCK_DGRAM:SOCK_STREAM;
    SOCKET server,source;int size,value;LPWSABUF callee,caller;LPQOS sqos=0,gqos=0;
    BYTE *descriptor,*payload,*caller_page;char result[8]={0};WSABUF normal_caller;
    if(!mapping)ExitProcess(20);shared=(volatile DWORD*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,64);if(!shared)ExitProcess(21);
    SetUnhandledExceptionFilter(fault);SetErrorMode(SEM_NOGPFAULTERRORBOX|SEM_FAILCRITICALERRORS);
    shared[0]=id;shared[1]=family;shared[2]=type;shared[3]=0;shared[4]=1;
    shared[5]=WSAStartup(MAKEWORD(2,2),&wsa);shared[6]=0xfeed;shared[7]=0xfeed;shared[8]=0;shared[9]=0;shared[10]=0x55;
    descriptor=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    payload=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    caller_page=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    if(!descriptor||!payload||!caller_page)ExitProcess(22);
    payload[0]=0x55;callee=(LPWSABUF)(descriptor+((mode==9||mode==10)?4092:0));
    callee->len=mode==3||mode==4?0:8;callee->buf=mode==2||mode==4?0:(char*)payload;
    normal_caller.len=8;normal_caller.buf=(char*)payload;caller=0;
    if(mode==0||mode>=11)callee=0;
    if(mode==5||mode==10)VirtualProtect(descriptor,4096,PAGE_READONLY,&protect);
    if(mode==6)VirtualProtect(descriptor,4096,PAGE_NOACCESS,&protect);
    if(mode==9)VirtualProtect(descriptor+4096,4096,PAGE_READONLY,&protect);
    if(mode==7||mode==11||mode==12||mode==13||mode==14)VirtualProtect(payload,4096,PAGE_NOACCESS,&protect);
    if(mode==8)VirtualProtect(payload,4096,PAGE_READONLY,&protect);
    if(mode==11){VirtualProtect(caller_page,4096,PAGE_NOACCESS,&protect);caller=(LPWSABUF)caller_page;}
    if(mode==12)sqos=(LPQOS)payload;
    if(mode==13)gqos=(LPQOS)payload;
    if(mode==14)caller=&normal_caller;
    server=socket(family,type,type==SOCK_STREAM?6:17);source=socket(family,type,type==SOCK_STREAM?6:17);
    zero(&address,sizeof(address));
    if(family==AF_INET){struct sockaddr_in *a=(struct sockaddr_in*)&address;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);size=sizeof(*a);}
    else{struct sockaddr_in6 *a=(struct sockaddr_in6*)&address;a->sin6_family=AF_INET6;a->sin6_addr.s6_addr[15]=1;size=sizeof(*a);}
    if(bind(server,(struct sockaddr*)&address,size)||getsockname(server,(struct sockaddr*)&address,&size)||(type==SOCK_STREAM&&listen(server,4)))ExitProcess(23);
    if(mode==15){closesocket(source);source=INVALID_SOCKET;callee=(LPWSABUF)descriptor;VirtualProtect(descriptor,4096,PAGE_NOACCESS,&protect);}
    shared[4]=2;SetLastError(0x1234);
    value=WSAConnect(source,mode==15?0:(struct sockaddr*)&address,size,caller,callee,sqos,gqos);
    shared[5]=value;shared[6]=WSAGetLastError();shared[4]=3;
    if(callee&&mode!=6&&mode!=15)shared[7]=callee->len;
    size=sizeof(local);shared[8]=getpeername(source,(struct sockaddr*)&local,&size)==0;
    size=sizeof(local);if(!getsockname(source,(struct sockaddr*)&local,&size))shared[9]=family==AF_INET?((struct sockaddr_in*)&local)->sin_port!=0:((struct sockaddr_in6*)&local)->sin6_port!=0;
    shared[10]=mode==7||mode==11||mode==12||mode==13||mode==14?0x55:payload[0];shared[4]=4;
    closesocket(source);closesocket(server);WSACleanup();ExitProcess(0);
}
static char *append(char *out,const char *text){while(*text)*out++=*text++;return out;}
static char *decimal(char *out,DWORD value){char digits[16];DWORD n=0;do{digits[n++]='0'+value%10;value/=10;}while(value);while(n)*out++=digits[--n];return out;}
void entry(void){
    char *line=GetCommandLineA();while(*line){if(*line++=='#'){DWORD id=0;while(*line>='0'&&*line<='9')id=id*10+*line++-'0';child(id);}}
    HANDLE mapping=CreateFileMappingA(INVALID_HANDLE_VALUE,0,PAGE_READWRITE,0,64,MAPNAME),output;DWORD written,id,index;
    char executable[1024],command[1100];STARTUPINFOA startup;PROCESS_INFORMATION process;
    SetErrorMode(SEM_NOGPFAULTERRORBOX|SEM_FAILCRITICALERRORS);
    shared=mapping?(volatile DWORD*)MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,64):0;
    if(!shared)ExitProcess(30);GetModuleFileNameA(0,executable,sizeof(executable));
    for(id=0;id<64;id++){
        for(index=0;index<16;index++)shared[index]=0xdeadbeef;
        char *p=append(command,"\"");p=append(p,executable);p=append(p,"\" #");p=decimal(p,id);*p=0;
        zero(&startup,sizeof(startup));startup.cb=sizeof(startup);zero(&process,sizeof(process));
        if(!CreateProcessA(executable,command,0,0,FALSE,CREATE_NO_WINDOW,0,0,&startup,&process)){record(GetLastError());break;}
        DWORD waited=WaitForSingleObject(process.hProcess,3000),exit_code=0;
        if(waited!=WAIT_OBJECT_0){TerminateProcess(process.hProcess,31);WaitForSingleObject(process.hProcess,1000);}
        GetExitCodeProcess(process.hProcess,&exit_code);record(waited);record(exit_code);
        for(index=0;index<11;index++)record(shared[index]);
        CloseHandle(process.hThread);CloseHandle(process.hProcess);if(waited!=WAIT_OBJECT_0)break;
    }
    oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}
    UnmapViewOfFile((const void*)shared);CloseHandle(mapping);ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
