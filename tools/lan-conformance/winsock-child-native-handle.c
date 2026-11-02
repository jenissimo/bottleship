#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];static DWORD count=3;static DWORD child_results[64];
static void record(DWORD value){oracle_results[count++]=value;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static void run_case(BOOL overlapped){
    WSADATA data;SOCKET source,peer;struct sockaddr_in address,remote;WSAPROTOCOL_INFOA info;STARTUPINFOA startup;PROCESS_INFORMATION child;
    DWORD input[3],written,bytes,exit_code=0,length,index;HANDLE file;int size;BOOL value;char path[512],command[560],buffer[8]={0};const char*name="lan-oracle-child.exe";DWORD timeout=1000;
    record(overlapped);record(WSAStartup(MAKEWORD(2,2),&data));
    source=WSASocketA(AF_INET,SOCK_DGRAM,17,0,0,overlapped?WSA_FLAG_OVERLAPPED:0);peer=socket(AF_INET,SOCK_DGRAM,17);record(source!=INVALID_SOCKET&&peer!=INVALID_SOCKET);
    zero(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);remote=address;
    outcome(bind(source,(struct sockaddr*)&address,sizeof(address)));outcome(bind(peer,(struct sockaddr*)&remote,sizeof(remote)));size=sizeof(address);outcome(getsockname(source,(struct sockaddr*)&address,&size));size=sizeof(remote);outcome(getsockname(peer,(struct sockaddr*)&remote,&size));outcome(connect(source,(struct sockaddr*)&remote,sizeof(remote)));
    length=GetModuleFileNameA(0,path,sizeof(path));while(length&&path[length-1]!='\\'&&path[length-1]!='/')length--;for(index=0;name[index];index++)path[length+index]=name[index];path[length+index]=0;
    command[0]='"';for(index=0;path[index];index++)command[index+1]=path[index];command[index+1]='"';command[index+2]=0;
    zero(&startup,sizeof(startup));zero(&child,sizeof(child));startup.cb=sizeof(startup);DeleteFileA("lan-child-result.bin");
    value=CreateProcessA(path,command,0,0,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,0,0,&startup,&child);record(value);record(value?0:GetLastError());if(!value){closesocket(source);closesocket(peer);WSACleanup();return;}
    outcome(WSADuplicateSocketA(source,child.dwProcessId,&info));input[0]=info.dwProviderReserved;input[1]=overlapped;input[2]=ORACLE_NONCE^(DWORD)overlapped;
    file=CreateFileA("lan-child-handle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);record(file!=INVALID_HANDLE_VALUE);
    value=WriteFile(file,input,sizeof(input),&written,0);record(value);record(written);record(FlushFileBuffers(file));CloseHandle(file);
    outcome(sendto(peer,"abc",3,0,(struct sockaddr*)&address,sizeof(address)));Sleep(30);
    record(ResumeThread(child.hThread));value=WaitForSingleObject(child.hProcess,10000);record(value);if(value==WAIT_TIMEOUT)TerminateProcess(child.hProcess,94);
    record(GetExitCodeProcess(child.hProcess,&exit_code));record(exit_code);
    zero(child_results,sizeof(child_results));file=CreateFileA("lan-child-result.bin",GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);record(file!=INVALID_HANDLE_VALUE);
    bytes=0;value=ReadFile(file,child_results,sizeof(child_results),&bytes,0);record(value);record(bytes);if(file!=INVALID_HANDLE_VALUE)CloseHandle(file);
#ifdef ORACLE_STAGING_CONTRACT
    /* Keep the unnormalised concurrent IOSB staging sample in an independent artifact. */
    {
        DWORD trace[13],trace_bytes=0,trace_written=0;HANDLE raw=CreateFileA("lan-child-staging.bin",GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0),copy;
        if(raw!=INVALID_HANDLE_VALUE){ReadFile(raw,trace,sizeof(trace),&trace_bytes,0);CloseHandle(raw);}
        copy=CreateFileA(overlapped?"lan-child-staging-overlapped.bin":"lan-child-staging-sync.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
        if(copy!=INVALID_HANDLE_VALUE){WriteFile(copy,trace,trace_bytes,&trace_written,0);CloseHandle(copy);}
    }
#endif
    record(child_results[0]==0x42534348);record(child_results[2]==input[2]);record(child_results[1]==(overlapped?38:32));for(index=3;index<(overlapped?38:32);index++)record(child_results[index]);
    setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,(const char*)&timeout,4);outcome(recv(peer,buffer,sizeof(buffer),0));record(buffer[0]);record(buffer[1]);record(buffer[2]);
    outcome(send(source,"ghi",3,0));outcome(recv(peer,buffer,sizeof(buffer),0));record(buffer[0]);record(buffer[2]);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);outcome(closesocket(source));outcome(closesocket(peer));record(WSACleanup());
}
void entry(void){run_case(FALSE);run_case(TRUE);finish();}
