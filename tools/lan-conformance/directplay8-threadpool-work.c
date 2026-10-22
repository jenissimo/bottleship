#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3,players,receives,callback_tid,local_id;
static GUID pool_class={0xfc47060e,0x6153,0x4b34,{0xb9,0x75,0x8e,0x41,0x21,0xeb,0x7f,0x3c}};
static GUID pool_iid={0x0d22ee73,0x4a46,0x4a0d,{0x89,0xb2,0x04,0x5b,0x4d,0x66,0x64,0x25}};
static GUID application={ORACLE_NONCE,0x7931,0x48c8,{0x90,0x31,0x62,0x43,0x59,0x83,0xb7,0x62}};
static void record(DWORD value){oracle_results[count++]=value;}
static HRESULT WINAPI pool_callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
    (void)context;
    if(message==DPN_MSGID_CREATE_PLAYER){DPNMSG_CREATE_PLAYER *m=data;players++;local_id=m->dpnidPlayer;callback_tid=GetCurrentThreadId();}
    if(message==DPN_MSGID_RECEIVE){receives++;callback_tid=GetCurrentThreadId();}
    return S_OK;
}
static void finish(void){
    HANDLE file;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
void entry(void){
    IDirectPlay8ThreadPool *pool=0;IDirectPlay8Peer *peer=0;IDirectPlay8Address *address=0;
    DPN_APPLICATION_DESC desc;DPN_BUFFER_DESC buffer;DWORD i,payload=0x12345678,handle=0,threads=99;HRESULT hr;
    CoInitialize(0);hr=CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void **)&pool);record(hr);if(FAILED(hr))finish();
    record(IDirectPlay8ThreadPool_Initialize(pool,0,pool_callback,0));record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));
    hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void **)&peer);record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8Peer_Initialize(peer,0,callback,0));
    hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void **)&address);record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));
    for(i=0;i<sizeof(desc);i++)((BYTE *)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication=application;desc.dwMaxPlayers=4;
    hr=IDirectPlay8Peer_Host(peer,&desc,&address,1,0,0,0,0);record(hr);if(FAILED(hr))goto cleanup;
    Sleep(25);record(players);record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(players);record(callback_tid==GetCurrentThreadId());
    buffer.dwBufferSize=4;buffer.pBufferData=(BYTE *)&payload;
    record(IDirectPlay8Peer_SendTo(peer,local_id,&buffer,1,0,0,&handle,DPNSEND_GUARANTEED));Sleep(25);record(receives);
    record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(receives);record(callback_tid==GetCurrentThreadId());
    record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,1,0));
    record(IDirectPlay8ThreadPool_GetThreadCount(pool,0xffffffff,&threads,0));record(threads>0);record(IDirectPlay8ThreadPool_DoWork(pool,0,0));
cleanup:
    if(peer){record(IDirectPlay8Peer_Close(peer,0));IDirectPlay8Peer_Release(peer);}
    if(address)IDirectPlay8Address_Release(address);
    record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);
    CoUninitialize();finish();
}
