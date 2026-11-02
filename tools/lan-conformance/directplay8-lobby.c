#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#include <dplobby8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3;
static GUID application={ORACLE_NONCE,0x6931,0x48c8,{0x90,0x31,0x22,0x43,0x59,0x83,0xb7,0x62}};
static void record(DWORD value){oracle_results[count++]=value;}
static void clear_bytes(void *value,DWORD size){BYTE *p=value;while(size--)*p++=0;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static void finish(void){
    DWORD written;HANDLE file;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
static int equal_guid(const GUID *a,const GUID *b){DWORD i;for(i=0;i<16;i++)if(((BYTE *)a)[i]!=((BYTE *)b)[i])return 0;return 1;}
typedef HRESULT (WINAPI *LobbyCreate)(const GUID *,void **,IUnknown *);
void entry(void){
    IDirectPlay8LobbyClient *client=0,*client2=0;IDirectPlay8LobbiedApplication *app=0,*app2=0;IUnknown *unknown=0;
    HMODULE dll;LobbyCreate create;HRESULT hr;DWORD size=0,items=99,handle=0xdeadbeef;BYTE byte=7;
    static BYTE buffer[2048];DPL_APPLICATION_INFO *entry=(DPL_APPLICATION_INFO *)buffer;
    DPL_PROGRAM_DESC program;DPL_CONNECTION_SETTINGS settings;BOOL registered=FALSE;
    CoInitialize(0);dll=LoadLibraryA("dpnlobby.dll");record(dll!=0);
    if(!dll)finish();create=(LobbyCreate)GetProcAddress(dll,"DirectPlay8LobbyCreate");record(create!=0);if(!create)finish();
    hr=create(&IID_IDirectPlay8LobbyClient,(void **)&client,0);record(hr);if(FAILED(hr))finish();
    hr=create(&IID_IDirectPlay8LobbiedApplication,(void **)&app,0);record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8LobbyClient_QueryInterface(client,&IID_IUnknown,(void **)&unknown));record((void *)unknown==(void *)client);if(unknown)IUnknown_Release(unknown);
    record(IDirectPlay8LobbyClient_Close(client,0));record(IDirectPlay8LobbiedApplication_Close(app,0));
    record(IDirectPlay8LobbyClient_EnumLocalPrograms(client,&application,0,&size,&items,0));record(size);record(items);
    record(IDirectPlay8LobbyClient_Initialize(client,0,0,0));
    record(IDirectPlay8LobbyClient_Initialize(client,(void *)0x1234,callback,2));
    record(IDirectPlay8LobbyClient_Initialize(client,(void *)0x1234,callback,0));
    record(IDirectPlay8LobbyClient_Initialize(client,0,callback,0));
    record(create(&IID_IDirectPlay8LobbyClient,(void **)&client2,0));
    record(IDirectPlay8LobbyClient_Initialize(client2,0,callback,0));
    clear_bytes(&settings,sizeof(settings));settings.dwSize=sizeof(settings);size=sizeof(settings);
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,0,&settings,&size,0));
    record(IDirectPlay8LobbyClient_Send(client,0,&byte,1,0));record(IDirectPlay8LobbyClient_ReleaseApplication(client,0,0));
    record(IDirectPlay8LobbiedApplication_SetAppAvailable(app,TRUE,0));
    record(IDirectPlay8LobbiedApplication_Initialize(app,(void *)0x5678,callback,&handle,0));record(handle);
    record(IDirectPlay8LobbiedApplication_Initialize(app,0,callback,0,0));
    record(create(&IID_IDirectPlay8LobbiedApplication,(void **)&app2,0));
    record(IDirectPlay8LobbiedApplication_Initialize(app2,0,callback,0,0));
    record(IDirectPlay8LobbiedApplication_SetAppAvailable(app,TRUE,0));
    record(IDirectPlay8LobbiedApplication_SetAppAvailable(app,FALSE,0));
    clear_bytes(&program,sizeof(program));program.dwSize=sizeof(program);program.guidApplication=application;
    program.pwszApplicationName=L"BS DPL8 oracle";program.pwszExecutableFilename=L"lan-oracle.exe";program.pwszExecutablePath=L"C:\\";
    record(IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,1));
    hr=IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0);record(hr);if(FAILED(hr))goto cleanup;registered=TRUE;
    size=0;items=99;record(IDirectPlay8LobbyClient_EnumLocalPrograms(client,&application,0,&size,&items,0));record(size);record(items);
    clear_bytes(buffer,sizeof(buffer));size=sizeof(buffer);items=99;
    hr=IDirectPlay8LobbyClient_EnumLocalPrograms(client,&application,buffer,&size,&items,0);record(hr);record(size);record(items);
    if(SUCCEEDED(hr)&&items){record(equal_guid(&entry->guidApplication,&application));record(entry->pwszApplicationName[0]=='B');record(entry->dwNumRunning);record(entry->dwNumWaiting);record(entry->dwFlags);}
cleanup:
    if(registered)record(IDirectPlay8LobbiedApplication_UnRegisterProgram(app,&application,0));
    if(app2)IDirectPlay8LobbiedApplication_Release(app2);
    if(app){record(IDirectPlay8LobbiedApplication_Close(app,0));IDirectPlay8LobbiedApplication_Release(app);}
    if(client2)IDirectPlay8LobbyClient_Release(client2);
    if(client){record(IDirectPlay8LobbyClient_Close(client,0));IDirectPlay8LobbyClient_Release(client);}
    CoUninitialize();finish();
}
