/* Pending self-COP buffer ownership: mutation occurs after SendTo returns,
 * before the manual thread pool processes RECEIVE. Each build runs one fresh peer. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_NOCOPY
#define ORACLE_NOCOPY 0
#endif
#define SEND_COUNT 2
static DWORD words[128],count=3,player,creates,destroys,receives,completes;
static DWORD payload[SEND_COUNT],received[SEND_COUNT],complete_flags[SEND_COUNT],complete_rtt[SEND_COUNT];
static DWORD complete_count[SEND_COUNT],complete_result[SEND_COUNT],complete_buffer_value[SEND_COUNT];
static DWORD complete_buffers[SEND_COUNT],complete_pointer[SEND_COUNT];
static DPN_BUFFER_DESC buffers[SEND_COUNT];
static DPNHANDLE handles[SEND_COUNT];
static GUID pool_class={0xfc47060e,0x6153,0x4b34,{0xb9,0x75,0x8e,0x41,0x21,0xeb,0x7f,0x3c}};
static GUID pool_iid={0x0d22ee73,0x4a46,0x4a0d,{0x89,0xb2,0x04,0x5b,0x4d,0x66,0x64,0x25}};
static void save(const char *name){
 HANDLE f;DWORD wrote;words[0]=0x42534c4e;words[1]=count;words[2]=ORACLE_NONCE;
 f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(f!=INVALID_HANDLE_VALUE){WriteFile(f,words,count*4,&wrote,0);CloseHandle(f);}
}
static void record(DWORD value){words[count++]=value;save("local-buffer-progress.bin");}
static HRESULT WINAPI pool_callback(void *context,DWORD message,void *data){(void)context;(void)message;(void)data;return S_OK;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 DWORD i;(void)context;
 if(message==DPN_MSGID_CREATE_PLAYER){creates++;player=((DPNMSG_CREATE_PLAYER*)data)->dpnidPlayer;}
 if(message==DPN_MSGID_DESTROY_PLAYER)destroys++;
 if(message==DPN_MSGID_RECEIVE){
  DPNMSG_RECEIVE *m=data;i=receives++;
  if(i<SEND_COUNT)received[i]=m->dwReceiveDataSize==4?*(DWORD*)m->pReceiveData:0xffffffff;
 }
 if(message==DPN_MSGID_SEND_COMPLETE){
  DPNMSG_SEND_COMPLETE *m=data;completes++;i=(DWORD)m->pvUserContext-0x2000;
  if(i<SEND_COUNT){complete_count[i]++;complete_result[i]=m->hResultCode;complete_flags[i]=m->dwSendCompleteFlags;complete_rtt[i]=m->dwFirstFrameRTT;
   complete_buffers[i]=m->dwNumBuffers;complete_pointer[i]=m->pBuffers&&m->dwNumBuffers==1&&m->pBuffers[0].pBufferData==(BYTE*)&payload[i];
   complete_buffer_value[i]=m->pBuffers&&m->dwNumBuffers==1&&m->pBuffers[0].dwBufferSize==4?*(DWORD*)m->pBuffers[0].pBufferData:0;
  }
 }
 return S_OK;
}
void entry(void){
 IDirectPlay8ThreadPool *pool=0;IDirectPlay8Address *address=0;IDirectPlay8Peer *peer=0;DPN_APPLICATION_DESC desc;
 DWORD i;HRESULT hr;CoInitialize(0);record(ORACLE_NOCOPY);
 hr=CoCreateInstance(&pool_class,0,CLSCTX_INPROC_SERVER,&pool_iid,(void**)&pool);record(hr);if(FAILED(hr))goto done;
 record(IDirectPlay8ThreadPool_Initialize(pool,0,pool_callback,0));record(IDirectPlay8ThreadPool_SetThreadCount(pool,0xffffffff,0,0));
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)&address);record(hr);if(FAILED(hr))goto done;
 record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));
 hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr))goto done;
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));
 for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;
 record(IDirectPlay8Peer_Host(peer,&desc,&address,1,0,0,0,0));record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(creates);
 for(i=0;i<SEND_COUNT;i++){
  payload[i]=0x12340000+i;buffers[i].dwBufferSize=4;buffers[i].pBufferData=(BYTE*)&payload[i];handles[i]=0;
  record(IDirectPlay8Peer_SendTo(peer,player,&buffers[i],1,0,(void*)(0x2000+i),&handles[i],DPNSEND_GUARANTEED|DPNSEND_COMPLETEONPROCESS|(ORACLE_NOCOPY?DPNSEND_NOCOPY:0)));
  record(handles[i]!=0);payload[i]=0xabcd0000+i;
 }
 record(receives);record(completes);record(IDirectPlay8ThreadPool_DoWork(pool,0,0));record(receives);record(completes);
 for(i=0;i<SEND_COUNT;i++){
  record(received[i]);record(complete_count[i]);record(complete_result[i]);record(complete_flags[i]);record(complete_rtt[i]);
  record(complete_buffers[i]);record(complete_pointer[i]);record(complete_buffer_value[i]);record(payload[i]);
 }
 record(IDirectPlay8Peer_Close(peer,0));record(destroys);
done:
 if(peer)IDirectPlay8Peer_Release(peer);if(address)IDirectPlay8Address_Release(address);
 if(pool){record(IDirectPlay8ThreadPool_Close(pool,0));IDirectPlay8ThreadPool_Release(pool);}
 save("lan-oracle.bin");CoUninitialize();ExitProcess(FAILED(hr)?1:0);
}
