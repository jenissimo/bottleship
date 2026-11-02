#define WIN32_LEAN_AND_MEAN
#include <windows.h>
/* Deliberately link only Kernel32: no Winsock import and no WSAStartup. */
static DWORD results[64],count=3,input[3];
static void record(DWORD value){results[count++]=value;}
static void zero(void*ptr,DWORD size){BYTE*p=ptr;while(size--)*p++=0;}
#ifdef ORACLE_STAGING_CONTRACT
static DWORD raw_stages[13],raw_count=3;
static void stage(BOOL value,DWORD error,DWORD bytes,const OVERLAPPED*ov,BOOL overlapped){
    DWORD internal=ov->Internal,high=ov->InternalHigh;
    raw_stages[raw_count++]=value;raw_stages[raw_count++]=error;raw_stages[raw_count++]=bytes;raw_stages[raw_count++]=internal;raw_stages[raw_count++]=high;
    record(value);record(error);record(bytes);
    /* IOSB can finish concurrently before a pending API returns. Preserve the raw sample separately. */
    record(overlapped?((value&&internal==0&&high==bytes)||(!value&&error==ERROR_IO_PENDING&&
        ((internal==0x103&&(high==0||high==3))||(internal==0&&high==3)))):(internal==0&&high==0));
    record(ov->Offset==0&&ov->OffsetHigh==0);
}
#else
static void stage(BOOL value,DWORD error,DWORD bytes,const OVERLAPPED*ov,BOOL overlapped){
    record(value);record(error);record(bytes);record(ov->Internal);record(ov->InternalHigh);
}
#endif
static void perform(HANDLE socket,BOOL overlapped){
    OVERLAPPED ov;HANDLE event=0;DWORD bytes=0xfeed;BOOL value;char buffer[8]={0};DWORD raw_error;
    zero(&ov,sizeof(ov));if(overlapped)event=ov.hEvent=CreateEventA(0,TRUE,FALSE,0);
    SetLastError(0x1234);value=ReadFile(socket,buffer,sizeof(buffer),&bytes,overlapped?&ov:0);raw_error=GetLastError();
    stage(value,raw_error,bytes,&ov,overlapped);
    if(overlapped){SetLastError(0x2345);value=GetOverlappedResult(socket,&ov,&bytes,TRUE);record(value);record(GetLastError());record(bytes);}
    record(buffer[0]);record(buffer[1]);record(buffer[2]);if(event)CloseHandle(event);
    zero(&ov,sizeof(ov));if(overlapped)event=ov.hEvent=CreateEventA(0,TRUE,FALSE,0);bytes=0xfeed;
    SetLastError(0x3456);value=WriteFile(socket,"def",3,&bytes,overlapped?&ov:0);raw_error=GetLastError();
    stage(value,raw_error,bytes,&ov,overlapped);
    if(overlapped){SetLastError(0x4567);value=GetOverlappedResult(socket,&ov,&bytes,TRUE);record(value);record(GetLastError());record(bytes);}
    if(event)CloseHandle(event);
}
void entry(void){
    HANDLE source,output;DWORD bytes=0,written,type,value;char buffer=0;
    source=CreateFileA("lan-child-handle.bin",GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);
    if(source==INVALID_HANDLE_VALUE||!ReadFile(source,input,sizeof(input),&bytes,0)||bytes!=sizeof(input))ExitProcess(91);
    CloseHandle(source);results[0]=0x42534348;results[2]=input[2];
    record(GetModuleHandleA("ws2_32.dll")==0);record(GetModuleHandleA("wsock32.dll")==0);
    SetLastError(0x5678);type=GetFileType((HANDLE)input[0]);record(type);record(GetLastError());
    perform((HANDLE)input[0],input[1]);
    record(GetModuleHandleA("ws2_32.dll")==0);record(GetModuleHandleA("wsock32.dll")==0);
    SetLastError(0x6789);value=CloseHandle((HANDLE)input[0]);record(value);record(GetLastError());
    SetLastError(0x789a);record(GetFileType((HANDLE)input[0]));record(GetLastError());
    bytes=0xfeed;SetLastError(0x89ab);value=ReadFile((HANDLE)0x7fffffff,&buffer,1,&bytes,0);record(value);record(GetLastError());record(bytes);
    bytes=0xfeed;SetLastError(0x9abc);value=WriteFile((HANDLE)0x7fffffff,&buffer,1,&bytes,0);record(value);record(GetLastError());record(bytes);
#ifdef ORACLE_STAGING_CONTRACT
    raw_stages[0]=0x42535257;raw_stages[1]=raw_count;raw_stages[2]=input[2];
    output=CreateFileA("lan-child-staging.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output==INVALID_HANDLE_VALUE)ExitProcess(95);
    value=WriteFile(output,raw_stages,raw_count*4,&written,0);CloseHandle(output);if(!value||written!=raw_count*4)ExitProcess(96);
#endif
    results[1]=count;output=CreateFileA("lan-child-result.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output==INVALID_HANDLE_VALUE)ExitProcess(92);
    value=WriteFile(output,results,count*4,&written,0);CloseHandle(output);ExitProcess(value&&written==count*4?17:93);
}
