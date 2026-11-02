#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_HOST_PORT
#define ORACLE_HOST_PORT 45100
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static IDirectPlay8Peer *peer;
static DWORD count=3,failure,phase;
static volatile DWORD ids[3],creates[3],destroys[3],mask,invalid,late,received,finish_received,destroy_contexts;
static BYTE *receive_pointer;static DPNHANDLE receive_handle;
static CRITICAL_SECTION lock;
static const WCHAR *names[3]={L"host",L"peer1",L"peer2"};
static void output(const char *name,const void *bytes,DWORD size){HANDLE h;DWORD n;h=CreateFileA(name,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(h!=INVALID_HANDLE_VALUE){WriteFile(h,bytes,size,&n,0);CloseHandle(h);}}
static void record(DWORD value){oracle_results[count++]=value;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;output("lan-oracle-progress.bin",(const void*)oracle_results,count*4);}
static int equal(const WCHAR *a,const WCHAR *b){if(!a||!b)return 0;while(*a&&*a==*b){a++;b++;}return *a==*b;}
static int role(DWORD id){DWORD i;for(i=0;i<3;i++)if(ids[i]==id)return (int)i;return -1;}
static int wait_value(volatile DWORD *value,DWORD expected){DWORD begin=GetTickCount();while(*value<expected){if(GetTickCount()-begin>9000)return 0;Sleep(1);}return 1;}
static DWORD WINAPI watchdog(void *unused){(void)unused;Sleep(25000);record(0xdead);ExitProcess(98);return 0;}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
 DWORD i,size;int source=-1;BYTE storage[256];DPN_PLAYER_INFO *info=(DPN_PLAYER_INFO*)storage;(void)context;
 if(message==DPN_MSGID_CREATE_PLAYER){
  DPNMSG_CREATE_PLAYER *m=data;for(i=0;i<sizeof(storage);i++)storage[i]=0;info->dwSize=sizeof(*info);size=sizeof(storage);
  if(SUCCEEDED(IDirectPlay8Peer_GetPeerInfo(peer,m->dpnidPlayer,info,&size,0)))for(i=0;i<3;i++)if(equal(info->pwszName,names[i]))source=(int)i;
  EnterCriticalSection(&lock);if(source>=0){ids[source]=m->dpnidPlayer;creates[source]++;mask|=1u<<source;m->pvPlayerContext=(void*)(0x1000+source);}else invalid++;LeaveCriticalSection(&lock);
 }else if(message==DPN_MSGID_RECEIVE){
  DPNMSG_RECEIVE *m=data;source=role(m->dpnidSender);
  if(source==1&&m->dwReceiveDataSize==4&&m->pReceiveData[0]==0x7e&&m->pReceiveData[1]==1&&m->pReceiveData[2]==3&&m->pReceiveData[3]==0){InterlockedIncrement((LONG*)&finish_received);return S_OK;}
  if(source!=1||m->dwReceiveDataSize!=4||m->pReceiveData[0]!=0x4d||m->pReceiveData[1]!=1||m->pReceiveData[2]!=0x37||m->pReceiveData[3]!=0x5b){InterlockedIncrement((LONG*)&invalid);return S_OK;}
  receive_pointer=m->pReceiveData;receive_handle=m->hBufferHandle;InterlockedIncrement((LONG*)&received);return DPNSUCCESS_PENDING;
 }else if(message==DPN_MSGID_DESTROY_PLAYER){
  DPNMSG_DESTROY_PLAYER *m=data;source=role(m->dpnidPlayer);EnterCriticalSection(&lock);
  if(source>=0){destroys[source]++;if(m->pvPlayerContext==(void*)(0x1000+source))destroy_contexts|=1u<<source;}else invalid++;LeaveCriticalSection(&lock);
 }
 if(phase==3)InterlockedIncrement((LONG*)&late);return S_OK;
}
static HRESULT address(IDirectPlay8Address **out,const WCHAR *host,DWORD port){
 DWORD n=0,traversal=0;HRESULT hr;const GUID loopback={0x4ce725f6,0x7b7f,0x4297,{0xba,0x6f,0x11,0xf9,0x65,0xbc,0x42,0x99}};
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)out);if(FAILED(hr))return hr;
 hr=IDirectPlay8Address_SetSP(*out,&CLSID_DP8SP_TCPIP);if(FAILED(hr))return hr;
 if(host){while(host[n])n++;hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_HOSTNAME,host,(n+1)*2,DPNA_DATATYPE_STRING);}
 else hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_DEVICE,&loopback,sizeof(loopback),DPNA_DATATYPE_GUID);
 if(FAILED(hr))return hr;hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_TRAVERSALMODE,&traversal,4,DPNA_DATATYPE_DWORD);if(FAILED(hr))return hr;
 return IDirectPlay8Address_AddComponent(*out,DPNA_KEY_PORT,&port,4,DPNA_DATATYPE_DWORD);
}
void entry(void){
 IDirectPlay8Address *device=0,*host=0,*remote=0;DPN_PLAYER_INFO info;DPN_APPLICATION_DESC desc;DPN_BUFFER_DESC buffer;
 BYTE data[]={0x4d,2,0x37,0x58},storage[256];DWORD i,n,type,port,context,total,before;HRESULT hr;HANDLE thread;
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);InitializeCriticalSection(&lock);
 thread=CreateThread(0,0,watchdog,0,0,0);if(thread)CloseHandle(thread);
 record(CoInitialize(0));hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr)){failure=1;goto done;}
 record(IDirectPlay8Peer_Initialize(peer,0,callback,0));
 for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME;info.pwszName=(WCHAR*)names[2];
 record(IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNSETPEERINFO_SYNC));
 record(address(&device,0,ORACLE_HOST_PORT+2));record(address(&host,L"127.0.0.1",ORACLE_HOST_PORT));
 for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=0x75e1;desc.dwMaxPlayers=3;
 phase=1;hr=IDirectPlay8Peer_Connect(peer,&desc,host,device,0,0,0,0,(void*)0x1002,0,0,DPNCONNECT_SYNC);record(hr);if(FAILED(hr)){failure=2;goto done;}
 record(wait_value(&mask,7));record(mask);
 for(i=0;i<3;i++){record(creates[i]);context=0;record(IDirectPlay8Peer_GetPlayerContext(peer,ids[i],(void**)&context,0));record(context==0x1000+i);}
 total=4;{DWORD players[4];record(IDirectPlay8Peer_EnumPlayersAndGroups(peer,players,&total,DPNENUM_PLAYERS));record(total);for(i=0;i<3;i++){DWORD j,seen=0;for(j=0;j<total&&j<4;j++)if(players[j]==ids[i])seen++;record(seen);}}
 for(i=0;i<2;i++){
  record(IDirectPlay8Peer_GetPeerAddress(peer,ids[i],&remote,0));port=0;n=4;type=0;
  if(remote){record(IDirectPlay8Address_GetComponentByName(remote,DPNA_KEY_PORT,&port,&n,&type));record(port==ORACLE_HOST_PORT+i);IDirectPlay8Address_Release(remote);remote=0;}
 }
 for(i=0;i<sizeof(storage);i++)storage[i]=0;((DPN_APPLICATION_DESC*)storage)->dwSize=sizeof(desc);n=sizeof(storage);
 record(IDirectPlay8Peer_GetApplicationDesc(peer,(DPN_APPLICATION_DESC*)storage,&n,0));record(((DPN_APPLICATION_DESC*)storage)->dwCurrentPlayers);
 buffer.pBufferData=data;buffer.dwBufferSize=4;record(IDirectPlay8Peer_SendTo(peer,ids[1],&buffer,1,3000,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC));
 record(wait_value(&received,1));record(received);record(receive_pointer&&receive_pointer[0]==0x4d&&receive_pointer[3]==0x5b);
 record(IDirectPlay8Peer_ReturnBuffer(peer,receive_handle,0));record(IDirectPlay8Peer_ReturnBuffer(peer,receive_handle,0));
 record(wait_value(&finish_received,1));record(finish_received);record(invalid);
done:
 phase=2;if(peer){record(IDirectPlay8Peer_Close(peer,0));phase=3;before=late;Sleep(25);record(late==before);for(i=0;i<3;i++)record(destroys[i]);record(destroy_contexts);IDirectPlay8Peer_Release(peer);}
 if(device)IDirectPlay8Address_Release(device);if(host)IDirectPlay8Address_Release(host);if(remote)IDirectPlay8Address_Release(remote);
 record(failure);output("lan-oracle.bin",(const void*)oracle_results,count*4);CoUninitialize();DeleteCriticalSection(&lock);ExitProcess(failure?1:0);
}
