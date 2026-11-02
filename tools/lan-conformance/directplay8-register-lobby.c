#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#include <dplobby8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3;
static void record(DWORD value){oracle_results[count++]=value;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static void finish(void){
    HANDLE file;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
void entry(void){
    IDirectPlay8Peer *peer=0;IDirectPlay8LobbiedApplication *app=0;HRESULT hr;DPNHANDLE handle=0;
    CoInitialize(0);
    hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void **)&peer);record(hr);if(FAILED(hr))finish();
    hr=CoCreateInstance(&CLSID_DirectPlay8LobbiedApplication,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8LobbiedApplication,(void **)&app);record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8Peer_RegisterLobby(peer,0,0,0));record(IDirectPlay8Peer_RegisterLobby(peer,0,0,3));
    record(IDirectPlay8Peer_RegisterLobby(peer,0,0,4));record(IDirectPlay8Peer_RegisterLobby(peer,0,app,1));
    record(IDirectPlay8Peer_RegisterLobby(peer,99,0,1));record(IDirectPlay8Peer_RegisterLobby(peer,99,app,1));
    record(IDirectPlay8Peer_Initialize(peer,0,callback,0));
    record(IDirectPlay8Peer_RegisterLobby(peer,0,app,1));record(IDirectPlay8Peer_RegisterLobby(peer,99,0,1));
    record(IDirectPlay8Peer_RegisterLobby(peer,99,app,1));record(IDirectPlay8Peer_RegisterLobby(peer,99,app,1));
    record(IDirectPlay8Peer_RegisterLobby(peer,99,0,2));record(IDirectPlay8Peer_RegisterLobby(peer,0,app,2));
    record(IDirectPlay8Peer_RegisterLobby(peer,0,0,2));record(IDirectPlay8Peer_RegisterLobby(peer,0,0,2));
    record(IDirectPlay8LobbiedApplication_Initialize(app,0,callback,&handle,0));
    record(IDirectPlay8Peer_RegisterLobby(peer,99,app,1));record(IDirectPlay8Peer_Close(peer,0));
    record(IDirectPlay8Peer_RegisterLobby(peer,0,0,2));record(IDirectPlay8LobbiedApplication_Close(app,0));
cleanup:
    if(app)IDirectPlay8LobbiedApplication_Release(app);IDirectPlay8Peer_Release(peer);CoUninitialize();finish();
}
