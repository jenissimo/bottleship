#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD record_count=3,records[256];static volatile DWORD received,local_id;
static const struct { DWORD flags; BOOL handle; } cases[]={
 {0,FALSE},{0,TRUE},{DPNSEND_NOCOMPLETE,FALSE},{DPNSEND_NOCOMPLETE,TRUE},
 {DPNSEND_GUARANTEED,FALSE},{DPNSEND_GUARANTEED,TRUE},{DPNSEND_GUARANTEED|DPNSEND_NOCOMPLETE,TRUE},
 {DPNSEND_COMPLETEONPROCESS,TRUE},{DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS,TRUE},
 {DPNSEND_SYNC,FALSE},{DPNSEND_SYNC|DPNSEND_NOCOPY,FALSE},{DPNSEND_SYNC|DPNSEND_NOCOMPLETE,FALSE},
 {DPNSEND_SYNC|DPNSEND_COMPLETEONPROCESS,FALSE},{DPNSEND_SYNC|DPNSEND_GUARANTEED,FALSE},
 {DPNSEND_SYNC|DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS,FALSE},{DPNSEND_SYNC|DPNSEND_NONSEQUENTIAL,FALSE},
 {DPNSEND_SYNC|DPNSEND_NOLOOPBACK,FALSE},{DPNSEND_SYNC|DPNSEND_GUARANTEED|DPNSEND_NOCOMPLETE,FALSE},
 {DPNSEND_COALESCE,TRUE},{DPNSEND_SYNC|DPNSEND_COALESCE,FALSE},{DPNSEND_SYNC|DPNSEND_PRIORITY_HIGH,FALSE},
 {DPNSEND_SYNC|DPNSEND_PRIORITY_HIGH|DPNSEND_PRIORITY_LOW,FALSE}
};
static void record(DWORD value){records[record_count++]=value;}
static HRESULT WINAPI callback(void *ctx,DWORD message,void *data){
 (void)ctx;if(message==DPN_MSGID_CREATE_PLAYER)local_id=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;
 if(message==DPN_MSGID_RECEIVE)InterlockedIncrement((LONG*)&received);return S_OK;
}
void entry(void){
 IDirectPlay8Peer *peer=0;IDirectPlay8Address *address=0;DPN_APPLICATION_DESC desc;DPN_BUFFER_DESC buffer;DPNHANDLE handle;
 GUID app={ORACLE_NONCE,0x7098,0x43a0,{0xa5,0x11,0x39,0x11,0x21,0x90,0xb4,0xd3}};
 DWORD i,before,begin,wrote;BYTE byte=1;HRESULT hr;HANDLE file;
 CoInitialize(0);hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&address);record(hr);if(FAILED(hr))goto finish;
 record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication=app;
 record(IDirectPlay8Peer_Host(peer,&desc,&address,1,0,0,0,0));record(local_id!=0);buffer.dwBufferSize=1;buffer.pBufferData=&byte;
 for(i=0;i<sizeof(cases)/sizeof(cases[0]);i++){
  before=received;handle=0xcccccccc;hr=IDirectPlay8Peer_SendTo(peer,local_id,&buffer,1,100,0,cases[i].handle?&handle:0,cases[i].flags);record(hr);
  record(handle==0xcccccccc?0:handle?1:2);begin=GetTickCount();if(SUCCEEDED(hr)&&!(cases[i].flags&DPNSEND_NOLOOPBACK))while(received==before&&GetTickCount()-begin<2000)Sleep(1);
  record(received-before);
 }
 buffer.dwBufferSize=0;record(IDirectPlay8Peer_SendTo(peer,local_id,&buffer,1,100,0,0,DPNSEND_SYNC));record(IDirectPlay8Peer_Close(peer,0));
finish:
 if(peer)IDirectPlay8Peer_Release(peer);if(address)IDirectPlay8Address_Release(address);CoUninitialize();
 records[0]=0x42534c4e;records[1]=record_count;records[2]=ORACLE_NONCE;
 file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file!=INVALID_HANDLE_VALUE){WriteFile(file,records,record_count*4,&wrote,0);CloseHandle(file);}ExitProcess(0);
}
