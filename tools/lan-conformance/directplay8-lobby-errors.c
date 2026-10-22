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
static GUID application={ORACLE_NONCE,0x7931,0x48c8,{0x90,0x31,0x62,0x43,0x59,0x83,0xb7,0x61}};
static void record(DWORD value){oracle_results[count++]=value;}
static void clear_bytes(void *value,DWORD size){BYTE *p=value;while(size--)*p++=0;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static void finish(void){
    HANDLE file;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
typedef HRESULT (WINAPI *LobbyCreate)(const GUID *,void **,IUnknown *);
void entry(void){
    IDirectPlay8LobbyClient *client=0;IDirectPlay8LobbiedApplication *app=0;HMODULE dll;LobbyCreate create;
    DPL_PROGRAM_DESC program;DPL_CONNECT_INFO connect;DWORD size=0,items=99,handle=99;BYTE data=1;HRESULT hr;GUID empty;void *unsupported;
    CoInitialize(0);dll=LoadLibraryA("dpnlobby.dll");if(!dll)finish();
    create=(LobbyCreate)GetProcAddress(dll,"DirectPlay8LobbyCreate");if(!create)finish();
    unsupported=(void *)0xdeadbeef;record(create(&IID_IUnknown,&unsupported,0));record(unsupported==(void *)0xdeadbeef);
    record(create(&IID_IUnknown,0,0));
    unsupported=(void *)0xdeadbeef;record(create(&IID_IDirectPlay8LobbyClient,&unsupported,(IUnknown *)1));record(unsupported==(void *)0xdeadbeef);
    record(create(&IID_IDirectPlay8LobbyClient,(void **)&client,0));record(create(&IID_IDirectPlay8LobbiedApplication,(void **)&app,0));if(!client||!app)finish();
    record(IDirectPlay8LobbyClient_Close(client,1));record(IDirectPlay8LobbiedApplication_Close(app,1));
    record(IDirectPlay8LobbyClient_EnumLocalPrograms(client,0,0,0,&items,0));
    record(IDirectPlay8LobbyClient_Send(client,0,0,0,1));
    record(IDirectPlay8LobbiedApplication_SetAppAvailable(app,TRUE,2));
    record(IDirectPlay8LobbiedApplication_UpdateStatus(app,0,1,1));
    record(IDirectPlay8LobbyClient_ReleaseApplication(client,0,1));
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,0,0,0,1));
    record(IDirectPlay8LobbyClient_SetConnectionSettings(client,0,0,1));
    record(IDirectPlay8LobbyClient_Initialize(client,0,callback,0));record(IDirectPlay8LobbiedApplication_Initialize(app,0,callback,&handle,0));
    record(IDirectPlay8LobbyClient_Send(client,0xffffffff,&data,1,0));
    record(IDirectPlay8LobbiedApplication_Send(app,0xffffffff,&data,1,0));
    record(IDirectPlay8LobbiedApplication_UpdateStatus(app,0xffffffff,1,0));
    record(IDirectPlay8LobbyClient_ReleaseApplication(client,0xffffffff,0));
    record(IDirectPlay8LobbiedApplication_SetConnectionSettings(app,0xffffffff,0,0));
    record(IDirectPlay8LobbyClient_SetConnectionSettings(client,0xffffffff,0,0));
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,0xffffffff,0,&size,0));
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,7,0,0,0));
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,7,0,&size,0));
    record(IDirectPlay8LobbyClient_Send(client,7,0,1,0));
    record(IDirectPlay8LobbyClient_Send(client,7,&data,0,0));
    record(IDirectPlay8LobbyClient_Send(client,7,&data,1,1));
    clear_bytes(&program,sizeof(program));program.dwSize=sizeof(program);program.guidApplication=application;
    record(IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0));
    program.pwszApplicationName=L"x";record(IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0));
    program.pwszExecutableFilename=L"bottleship-never.exe";
    hr=IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0);record(hr);if(SUCCEEDED(hr))record(IDirectPlay8LobbiedApplication_UnRegisterProgram(app,&application,0));else record(0);
    program.pwszApplicationName=L"";hr=IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0);record(hr);
    if(SUCCEEDED(hr))record(IDirectPlay8LobbiedApplication_UnRegisterProgram(app,&application,0));else record(0);
    clear_bytes(&empty,sizeof(empty));program.dwFlags=1;record(IDirectPlay8LobbiedApplication_RegisterProgram(app,&program,0));program.dwFlags=0;
    clear_bytes(&connect,sizeof(connect));connect.dwSize=sizeof(connect);connect.guidApplication=application;connect.dwFlags=3;
    record(IDirectPlay8LobbyClient_ConnectApplication(client,&connect,0,&handle,1,0));
    connect.dwFlags=0;connect.guidApplication=empty;record(IDirectPlay8LobbyClient_ConnectApplication(client,&connect,0,&handle,1,0));
    connect.guidApplication=application;record(IDirectPlay8LobbyClient_ConnectApplication(client,&connect,0,&handle,1,0));
    record(IDirectPlay8LobbiedApplication_Close(app,0));record(IDirectPlay8LobbyClient_Close(client,0));
    IDirectPlay8LobbiedApplication_Release(app);IDirectPlay8LobbyClient_Release(client);CoUninitialize();finish();
}
