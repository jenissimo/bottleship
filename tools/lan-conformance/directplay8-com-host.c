/* Finite API-only x86 Host/Peer oracle. Ordinary loopback, no DLL hooks. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_HOST_PORT
#define ORACLE_HOST_PORT 45120
#endif
#define LIMIT 512
#define ROWS 64
static IDirectPlay8Peer *dp;
static DWORD role,reject_mode,phase,failure,obs[LIMIT],used=3,rows[ROWS][12],row_count,dropped;
static volatile DWORD ids[2],created[2],destroyed[2],received,connect_count,connect_hr,connect_size,connect_ctx,connect_reply;
static volatile DWORD indicates,returned,aborted,initial_zero,connect_input,reply_pointer,reply_context,reply_original,app_during;
static volatile DWORD initial_context[2],destroy_context[2],reason[2],late;
static BYTE reply[8],input[8],reply_copy[16],*retained;
static DPNHANDLE receive_handle,connect_handle;
static CRITICAL_SECTION lock;
static HANDLE stop_watchdog,watchdog_thread;
static const WCHAR *names[2]={L"stage28-com-host",L"stage28-com-peer"};
static void zero(void *p,DWORD n){DWORD i;for(i=0;i<n;i++)((BYTE*)p)[i]=0;}
static void copy(void *p,const void *s,DWORD n){DWORD i;for(i=0;i<n;i++)((BYTE*)p)[i]=((const BYTE*)s)[i];}
static int same(const BYTE *a,const BYTE *b,DWORD n){DWORD i;if(!a||!b)return 0;for(i=0;i<n;i++)if(a[i]!=b[i])return 0;return 1;}
static int wide_equal(const WCHAR *a,const WCHAR *b){if(!a||!b)return 0;while(*a&&*a==*b){a++;b++;}return *a==*b;}
static int contains(const char *p,const char *q){const char *a,*b;while(*p){a=p;b=q;while(*a&&*b&&*a==*b){a++;b++;}if(!*b)return 1;p++;}return 0;}
static void file(const char *path,const void *p,DWORD n){HANDLE h;DWORD done;h=CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(h!=INVALID_HANDLE_VALUE){WriteFile(h,p,n,&done,0);FlushFileBuffers(h);CloseHandle(h);}}
static void record(DWORD tag,DWORD value){if(used+2<LIMIT){obs[used++]=tag;obs[used++]=value;}obs[0]=0x42534c4e;obs[1]=used;obs[2]=ORACLE_NONCE;file("host-progress.bin",obs,used*4);}
static void marker(const char *path){DWORD n=ORACLE_NONCE;file(path,&n,4);}
static int marked(const char *path){HANDLE h;DWORD n=0,done=0;h=CreateFileA(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);if(h==INVALID_HANDLE_VALUE)return 0;ReadFile(h,&n,4,&done,0);CloseHandle(h);return done==4&&n==ORACLE_NONCE;}
static int wait_mark(const char *path,DWORD ms){DWORD start=GetTickCount();while(!marked(path)){if(GetTickCount()-start>=ms)return 0;Sleep(1);}return 1;}
static int wait_count(volatile DWORD *p,DWORD n,DWORD ms){DWORD start=GetTickCount();while(*p<n){if(GetTickCount()-start>=ms)return 0;Sleep(1);}return 1;}
static void trace(DWORD message,DWORD size,DWORD id,DWORD context,DWORD result,DWORD count,DWORD extra){
 DWORD *r,header[7];EnterCriticalSection(&lock);
 if(row_count<ROWS){r=rows[row_count];r[0]=row_count;r[1]=GetTickCount();r[2]=GetCurrentThreadId();r[3]=message;r[4]=phase;r[5]=size;r[6]=id;r[7]=context;r[8]=result;r[9]=count;r[10]=extra;r[11]=role;row_count++;}else dropped++;
 header[0]=0x42534843;header[1]=1;header[2]=ORACLE_NONCE;header[3]=role;header[4]=reject_mode;header[5]=row_count;header[6]=dropped;
 file("callback-header.bin",header,sizeof(header));file("callback-rows.bin",rows,row_count*sizeof(rows[0]));LeaveCriticalSection(&lock);
}
static DWORD player_role(DPNID id){BYTE buffer[256];DPN_PLAYER_INFO *p=(DPN_PLAYER_INFO*)buffer;DWORD n=sizeof(buffer);zero(buffer,sizeof(buffer));p->dwSize=sizeof(*p);
 if(IDirectPlay8Peer_GetPeerInfo(dp,id,p,&n,0)!=DPN_OK)return 2;if(wide_equal(p->pwszName,names[0]))return 0;if(wide_equal(p->pwszName,names[1]))return 1;return 2;}
static HRESULT WINAPI handler(void *context,DWORD message,void *data){
 (void)context;if(phase==3)late++;
 if(message==DPN_MSGID_CREATE_PLAYER){DPNMSG_CREATE_PLAYER *m=data;DWORD r=player_role(m->dpnidPlayer);trace(message,m->dwSize,m->dpnidPlayer,(DWORD)m->pvPlayerContext,0,r,0);
  if(r<2){ids[r]=m->dpnidPlayer;initial_context[r]=(DWORD)m->pvPlayerContext==(r==role?(role?0x7101:0x7100):(role?0:0x7201));m->pvPlayerContext=(void*)(0x7500+r);created[r]++;}else failure=31;}
 else if(message==DPN_MSGID_DESTROY_PLAYER){DPNMSG_DESTROY_PLAYER *m=data;DWORD r=m->dpnidPlayer==ids[0]?0:m->dpnidPlayer==ids[1]?1:2;trace(message,m->dwSize,m->dpnidPlayer,(DWORD)m->pvPlayerContext,m->dwReason,r,0);
  if(r<2){destroy_context[r]=(DWORD)m->pvPlayerContext==0x7500+r;reason[r]=m->dwReason;destroyed[r]++;}else failure=32;}
 else if(message==DPN_MSGID_INDICATE_CONNECT){DPNMSG_INDICATE_CONNECT *m=data;BYTE storage[256];DPN_APPLICATION_DESC *a=(DPN_APPLICATION_DESC*)storage;DWORD n=sizeof(storage),i;
  indicates++;initial_zero=!m->pvReplyData&&!m->dwReplyDataSize&&!m->pvReplyContext&&!m->pvPlayerContext;connect_input=m->dwUserConnectDataSize==8&&same(m->pvUserConnectData,input,8);
  zero(storage,sizeof(storage));a->dwSize=sizeof(*a);if(IDirectPlay8Peer_GetApplicationDesc(dp,a,&n,0)==DPN_OK)app_during=a->dwCurrentPlayers;
  for(i=0;i<8;i++)reply[i]=(BYTE)(i+0x40);reply[1]=(BYTE)reject_mode;reply[2]=(BYTE)ORACLE_NONCE;
  m->pvReplyData=reply;m->dwReplyDataSize=8;m->pvReplyContext=(void*)0x7301;m->pvPlayerContext=(void*)0x7201;
  trace(message,m->dwSize,0,(DWORD)m->pvPlayerContext,reject_mode?E_FAIL:S_OK,m->dwUserConnectDataSize,app_during);return reject_mode?E_FAIL:S_OK;}
 else if(message==DPN_MSGID_RETURN_BUFFER){DPNMSG_RETURN_BUFFER *m=data;DWORD i;returned++;reply_pointer=m->pvBuffer==reply;reply_context=m->pvUserContext==(void*)0x7301;reply_original=same(m->pvBuffer,reply,8);
  trace(message,m->dwSize,0,(DWORD)m->pvUserContext,m->hResultCode,0,reply_pointer);for(i=0;i<8;i++)reply[i]=(BYTE)(0xe0+i);}
 else if(message==DPN_MSGID_CONNECT_COMPLETE){DPNMSG_CONNECT_COMPLETE *m=data;DWORD i;connect_hr=m->hResultCode;connect_size=m->dwApplicationReplyDataSize;connect_ctx=m->pvUserContext==(void*)0x7401;
  zero(reply_copy,sizeof(reply_copy));if(m->pvApplicationReplyData&&connect_size<=sizeof(reply_copy))copy(reply_copy,m->pvApplicationReplyData,connect_size);
  connect_reply=connect_size==8;for(i=0;i<8&&connect_reply;i++){BYTE expected=(BYTE)(i+0x40);if(i==1)expected=(BYTE)reject_mode;if(i==2)expected=(BYTE)ORACLE_NONCE;if(reply_copy[i]!=expected)connect_reply=0;}
  trace(message,m->dwSize,m->dpnidLocal,(DWORD)m->pvUserContext,m->hResultCode,connect_size,m->hAsyncOp!=0);connect_count++;}
 else if(message==DPN_MSGID_RECEIVE){DPNMSG_RECEIVE *m=data;trace(message,m->dwSize,m->dpnidSender,(DWORD)m->pvPlayerContext,0,m->dwReceiveDataSize,m->dwReceiveFlags);
  if(m->dwReceiveDataSize==4&&!received){retained=m->pReceiveData;receive_handle=m->hBufferHandle;received++;return DPNSUCCESS_PENDING;}failure=33;}
 else if(message==DPN_MSGID_INDICATED_CONNECT_ABORTED){DPNMSG_INDICATED_CONNECT_ABORTED *m=data;aborted++;trace(message,m->dwSize,0,(DWORD)m->pvPlayerContext,0,0,0);}
 return DPN_OK;
}
static DWORD WINAPI watchdog(void *unused){(void)unused;if(WaitForSingleObject(stop_watchdog,35000)==WAIT_TIMEOUT){DWORD values[4]={ORACLE_NONCE,role,phase,failure};file("watchdog.bin",values,sizeof(values));ExitProcess(98);}return 0;}
static HRESULT address(IDirectPlay8Address **out,int remote){HRESULT hr;DWORD port=ORACLE_HOST_PORT+(remote?0:role),traversal=0;GUID device={0x4ce725f6,0x7b7f,0x4297,{0xba,0x6f,0x11,0xf9,0x65,0xbc,0x42,0x99}};
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)out);if(FAILED(hr))return hr;
 hr=IDirectPlay8Address_SetSP(*out,&CLSID_DP8SP_TCPIP);if(FAILED(hr))return hr;
 if(remote)hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_HOSTNAME,L"127.0.0.1",20,DPNA_DATATYPE_STRING);
 else hr=IDirectPlay8Address_SetDevice(*out,&device);if(FAILED(hr))return hr;
 hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_PORT,&port,4,DPNA_DATATYPE_DWORD);if(FAILED(hr))return hr;
 if(!remote)hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_TRAVERSALMODE,&traversal,4,DPNA_DATATYPE_DWORD);return hr;
}
static void snapshot(DWORD base){DWORD i;record(base,indicates);record(base+1,returned);record(base+2,aborted);record(base+3,connect_count);record(base+4,connect_hr);
 record(base+5,connect_size);record(base+6,connect_ctx);record(base+7,connect_reply);record(base+8,initial_zero);record(base+9,connect_input);
 record(base+10,reply_pointer);record(base+11,reply_context);record(base+12,reply_original);record(base+13,app_during);record(base+14,received);
 for(i=0;i<2;i++){record(base+20+i,created[i]);record(base+22+i,destroyed[i]);record(base+24+i,initial_context[i]);record(base+26+i,destroy_context[i]);record(base+28+i,reason[i]);}}
static void main_body(void){IDirectPlay8Address *device=0,*host=0;DPN_APPLICATION_DESC app;DPN_PLAYER_INFO player;DPN_CAPS caps;HRESULT hr;DWORD n;BYTE payload[4]={0x48,0,0x28,0x7a};DPN_BUFFER_DESC buffer;void *context=0;
 zero(input,8);input[0]=0x43;input[1]=0x31;input[2]=(BYTE)ORACLE_NONCE;input[3]=0;input[4]=0x28;input[5]=0x48;input[6]=0x4f;input[7]=0x53;
 record(1,role);record(2,reject_mode);hr=CoInitialize(0);record(3,hr);if(FAILED(hr)){failure=1;return;}
 hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&dp);record(4,hr);if(FAILED(hr)){failure=2;goto done;}
 hr=IDirectPlay8Peer_Initialize(dp,(void*)0x7001,handler,0);record(5,hr);if(FAILED(hr)){failure=3;goto done;}
 zero(&caps,sizeof(caps));caps.dwSize=sizeof(caps);caps.dwConnectTimeout=150;caps.dwConnectRetries=10;caps.dwTimeoutUntilKeepAlive=5000;record(6,IDirectPlay8Peer_SetCaps(dp,&caps,0));
 zero(&player,sizeof(player));player.dwSize=sizeof(player);player.dwInfoFlags=DPNINFO_NAME;player.pwszName=(WCHAR*)names[role];record(7,IDirectPlay8Peer_SetPeerInfo(dp,&player,0,0,DPNSETPEERINFO_SYNC));
 hr=address(&device,0);record(8,hr);if(FAILED(hr)){failure=4;goto done;}
 zero(&app,sizeof(app));app.dwSize=sizeof(app);app.guidApplication.Data1=ORACLE_NONCE;app.guidApplication.Data2=0x28b2;app.dwMaxPlayers=2;app.pwszSessionName=L"API native Host";
 phase=1;
 if(!role){IDirectPlay8Address *list[4]={0,0,0,0};WCHAR url[512];DWORD count=4,chars=512;BYTE desc[256];DPN_APPLICATION_DESC *actual=(DPN_APPLICATION_DESC*)desc;
  hr=IDirectPlay8Peer_Host(dp,&app,&device,1,0,0,(void*)0x7100,0);record(9,hr);if(FAILED(hr)){failure=5;goto done;}
  if(!wait_count(&created[0],1,5000)){failure=6;goto done;}
  record(10,IDirectPlay8Peer_GetLocalHostAddresses(dp,list,&count,0));record(11,count>0);n=0;
  if(list[0]){DWORD size=4,type=0,port=0;hr=IDirectPlay8Address_GetComponentByName(list[0],DPNA_KEY_PORT,&port,&size,&type);record(12,hr);record(13,port==ORACLE_HOST_PORT);
   zero(url,sizeof(url));record(14,IDirectPlay8Address_GetURLW(list[0],url,&chars));file("host-address-url.bin",url,chars*2);n=1;}record(15,n);
  for(n=0;n<count&&n<4;n++)if(list[n])IDirectPlay8Address_Release(list[n]);marker("host-ready.bin");
  if(!wait_count(&indicates,1,10000)||!wait_count(&returned,1,5000)){failure=7;goto done;}
  if(!reject_mode&&!wait_count(&created[1],1,5000)){failure=8;goto done;}
  snapshot(100);marker("host-admission-done.bin");
  if(!reject_mode){marker("exchange-ready.bin");if(!wait_mark("send-go.bin",8000)){failure=9;goto done;}
   payload[1]=0;buffer.dwBufferSize=4;buffer.pBufferData=payload;record(220,IDirectPlay8Peer_SendTo(dp,ids[1],&buffer,1,0,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC));
   if(!wait_count(&received,1,8000)){failure=10;goto done;}
   record(221,retained!=0);record(222,retained&&retained[0]==0x48&&retained[1]==1&&retained[2]==0x28&&retained[3]==0x7a);
   record(223,IDirectPlay8Peer_ReturnBuffer(dp,receive_handle,0));record(224,IDirectPlay8Peer_ReturnBuffer(dp,receive_handle,0));marker("exchange-done.bin");
   if(!wait_count(&destroyed[1],1,10000)){failure=11;goto done;}marker("host-peer-closed.bin");}
  if(!wait_mark("host-close-go.bin",10000)){failure=12;goto done;}
  zero(desc,sizeof(desc));actual->dwSize=sizeof(*actual);n=sizeof(desc);record(240,IDirectPlay8Peer_GetApplicationDesc(dp,actual,&n,0));
 }else{
  hr=address(&host,1);record(16,hr);if(FAILED(hr)){failure=13;goto done;}
  zero(&app,sizeof(app));app.dwSize=sizeof(app);app.guidApplication.Data1=ORACLE_NONCE;app.guidApplication.Data2=0x28b2;
  hr=IDirectPlay8Peer_Connect(dp,&app,host,device,0,0,input,8,(void*)0x7101,(void*)0x7401,&connect_handle,0);record(17,hr);record(18,connect_handle!=0);
  if(hr!=DPNSUCCESS_PENDING||!wait_count(&connect_count,1,10000)){failure=14;goto done;}
  record(19,connect_hr);snapshot(100);marker("peer-admission-done.bin");
  if(!reject_mode){if(FAILED(connect_hr)||!wait_count(&created[0],1,5000)||!wait_count(&created[1],1,5000)){failure=15;goto done;}
   record(200,IDirectPlay8Peer_GetPlayerContext(dp,ids[1],&context,0));record(201,context==(void*)0x7501);
   marker("exchange-ready.bin");if(!wait_mark("send-go.bin",8000)){failure=16;goto done;}payload[1]=1;buffer.dwBufferSize=4;buffer.pBufferData=payload;
   record(220,IDirectPlay8Peer_SendTo(dp,ids[0],&buffer,1,0,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC));
   if(!wait_count(&received,1,8000)){failure=17;goto done;}
   record(221,retained!=0);record(222,retained&&retained[0]==0x48&&retained[1]==0&&retained[2]==0x28&&retained[3]==0x7a);
   record(223,IDirectPlay8Peer_ReturnBuffer(dp,receive_handle,0));record(224,IDirectPlay8Peer_ReturnBuffer(dp,receive_handle,0));marker("exchange-done.bin");
  }else if(!FAILED(connect_hr)){failure=18;goto done;}
  if(!wait_mark("peer-close-go.bin",10000)){failure=19;goto done;}
 }
 done:
 phase=2;if(dp){record(250,IDirectPlay8Peer_Close(dp,0));IDirectPlay8Peer_Release(dp);dp=0;}phase=3;
 if(host)IDirectPlay8Address_Release(host);if(device)IDirectPlay8Address_Release(device);CoUninitialize();
 snapshot(300);record(340,late);record(341,dropped);record(399,failure);file("lan-oracle.bin",obs,used*4);marker("done.bin");
}
void entry(void){DWORD exit_code;role=contains(GetCommandLineA(),"--peer");reject_mode=contains(GetCommandLineA(),"--reject");InitializeCriticalSection(&lock);
 stop_watchdog=CreateEventA(0,TRUE,FALSE,0);watchdog_thread=CreateThread(0,0,watchdog,0,0,0);main_body();exit_code=failure?1:0;
 SetEvent(stop_watchdog);WaitForSingleObject(watchdog_thread,2000);CloseHandle(watchdog_thread);CloseHandle(stop_watchdog);DeleteCriticalSection(&lock);ExitProcess(exit_code);}
