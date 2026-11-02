/* Stage29 draft: finite public-API-only Host + one Peer SetPeerInfo oracle.
 * Native results, not source predictions, become reference; preserve every first RED.
 * Build later with unique ORACLE_NONCE and caller-selected ORACLE_HOST_PORT.
 * Controller owns separate role directories and nonce-stamped phase barriers.
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_HOST_PORT
#define ORACLE_HOST_PORT 55172
#endif
#define LIMIT 2048
#define ROWS 128
#define TIMEOUT 8000
static IDirectPlay8Peer *dp;
static DWORD role,phase,failure,obs[LIMIT],used=3;
static volatile LONG created[2],destroyed[2],info_count[2],async_count,connect_count,late;
static DPNID ids[2];
static DPNHANDLE async_handle,completed_handle;
static HRESULT async_result,connect_result;
static DWORD completed_context,callback_rows[ROWS][16],row_count,dropped;
static CRITICAL_SECTION trace_lock;
static HANDLE watchdog_stop,watchdog_thread;
static WCHAR *initial_name[2]={L"host-initial",L"peer-initial"};
static WCHAR *updated_name[2]={L"host-\x0416",L"peer-\x0416"};
static BYTE initial_data[2][4]={{0x20,0,0x40,0},{0x21,0,0x40,1}};
static BYTE updated_data[2][4]={{0x30,0,0x50,0},{0x31,0,0x50,1}};
static void zero(void *p,DWORD n){DWORD i;for(i=0;i<n;i++)((BYTE*)p)[i]=0;}
static void copy(void *d,const void *s,DWORD n){DWORD i;for(i=0;i<n;i++)((BYTE*)d)[i]=((const BYTE*)s)[i];}
static int equal(const BYTE *a,const BYTE *b,DWORD n){DWORD i;if(!a||!b)return 0;for(i=0;i<n;i++)if(a[i]!=b[i])return 0;return 1;}
static int wide_equal(const WCHAR *a,const WCHAR *b){if(!a||!b)return a==b;while(*a&&*a==*b){a++;b++;}return *a==*b;}
static int contains(const char *p,const char *needle){const char *a,*b;while(*p){a=p;b=needle;while(*a&&*b&&*a==*b){a++;b++;}if(!*b)return 1;p++;}return 0;}
static DWORD hash_bytes(const BYTE *p,DWORD n){DWORD h=2166136261u,i;if(!p)return n?0xdead0001u:0;for(i=0;i<n;i++)h=(h^p[i])*16777619u;return h;}
static DWORD hash_wide(const WCHAR *p){DWORD n=0;if(!p)return 0;while(p[n]&&n<256)n++;return hash_bytes((const BYTE*)p,n*2);}
static void file(const char *path,const void *p,DWORD n){DWORD done=0;HANDLE h=CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(h!=INVALID_HANDLE_VALUE){WriteFile(h,p,n,&done,0);FlushFileBuffers(h);CloseHandle(h);}}
static void record(DWORD tag,DWORD value){if(used+2<LIMIT){obs[used++]=tag;obs[used++]=value;}else failure=90;obs[0]=0x42534c4e;obs[1]=used;obs[2]=ORACLE_NONCE;file("info-progress.bin",obs,used*4);}
static void marker(const char *path){DWORD n=ORACLE_NONCE;file(path,&n,4);}
static int marked(const char *path){DWORD n=0,done=0;HANDLE h=CreateFileA(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);if(h==INVALID_HANDLE_VALUE)return 0;ReadFile(h,&n,4,&done,0);CloseHandle(h);return done==4&&n==ORACLE_NONCE;}
static void step_path(char *s,DWORD step,const char *suffix){DWORD i=0,j=0;s[i++]='s';s[i++]='t';s[i++]='e';s[i++]='p';s[i++]='-';s[i++]=(char)('0'+step);s[i++]='-';while(suffix[j])s[i++]=suffix[j++];s[i]=0;}
static int wait_mark(const char *path){DWORD start=GetTickCount();while(!marked(path)){if(GetTickCount()-start>=TIMEOUT)return 0;Sleep(1);}return 1;}
static int wait_count(volatile LONG *p,LONG n){DWORD start=GetTickCount();while(*p<n){if(GetTickCount()-start>=TIMEOUT)return 0;Sleep(1);}return 1;}
static DWORD normalized(DPNID id){if(ids[0]&&id==ids[0])return 0;if(ids[1]&&id==ids[1])return 1;return 2;}
static DWORD name_class(const WCHAR *p,DWORD r){if(!p)return 2;if(!p[0])return 3;if(r<2&&wide_equal(p,initial_name[r]))return 0;if(r<2&&wide_equal(p,updated_name[r]))return 1;return 4;}
static DWORD data_class(const BYTE *p,DWORD n,DWORD r){if(!n)return p?3:2;if(n==4&&r<2&&equal(p,initial_data[r],4))return 0;if(n==4&&r<2&&equal(p,updated_data[r],4))return 1;return 4;}
typedef struct Query {DWORD size,flags,name_present,name_kind,name_hash,data_present,data_size,data_kind,data_hash;HRESULT hr;} Query;
static Query query(DPNID id,DWORD r){BYTE bytes[512];DPN_PLAYER_INFO *info=(DPN_PLAYER_INFO*)bytes;DWORD n=sizeof(bytes);Query q;zero(&q,sizeof(q));zero(bytes,sizeof(bytes));info->dwSize=sizeof(*info);
 q.hr=IDirectPlay8Peer_GetPeerInfo(dp,id,info,&n,0);q.size=n;
 if(SUCCEEDED(q.hr)){q.flags=info->dwPlayerFlags;q.name_present=info->pwszName!=0;q.name_kind=name_class(info->pwszName,r);q.name_hash=hash_wide(info->pwszName);q.data_present=info->pvData!=0;q.data_size=info->dwDataSize;q.data_kind=data_class(info->pvData,info->dwDataSize,r);q.data_hash=hash_bytes(info->pvData,info->dwDataSize);}
 return q;}
static void trace(DWORD message,DWORD size,DPNID id,DWORD context,HRESULT result,DPNHANDLE handle,Query *q){DWORD *r,header[6];EnterCriticalSection(&trace_lock);
 if(row_count<ROWS){r=callback_rows[row_count];r[0]=row_count;r[1]=GetTickCount();r[2]=GetCurrentThreadId();r[3]=message;r[4]=phase;r[5]=size;r[6]=id;r[7]=normalized(id);r[8]=context;r[9]=result;r[10]=handle;r[11]=q?q->hr:0;r[12]=q?q->name_kind:0;r[13]=q?q->data_kind:0;r[14]=q?q->name_hash:0;r[15]=q?q->data_hash:0;row_count++;}else dropped++;
 header[0]=0x42534946;header[1]=1;header[2]=ORACLE_NONCE;header[3]=role;header[4]=row_count;header[5]=dropped;file("info-callback-header.bin",header,sizeof(header));file("info-callback-rows.bin",callback_rows,row_count*sizeof(callback_rows[0]));LeaveCriticalSection(&trace_lock);
}
static HRESULT WINAPI handler(void *context,DWORD message,void *data){(void)context;if(phase==100)InterlockedIncrement(&late);
 if(message==DPN_MSGID_CREATE_PLAYER){DPNMSG_CREATE_PLAYER *m=data;BYTE buf[512];DPN_PLAYER_INFO *p=(DPN_PLAYER_INFO*)buf;DWORD n=sizeof(buf),r=2;zero(buf,sizeof(buf));p->dwSize=sizeof(*p);
  if(SUCCEEDED(IDirectPlay8Peer_GetPeerInfo(dp,m->dpnidPlayer,p,&n,0))){if(wide_equal(p->pwszName,initial_name[0]))r=0;else if(wide_equal(p->pwszName,initial_name[1]))r=1;}
  if(r<2){ids[r]=m->dpnidPlayer;m->pvPlayerContext=(void*)(0xa100+r);InterlockedIncrement(&created[r]);}else failure=20;trace(message,m->dwSize,m->dpnidPlayer,(DWORD)m->pvPlayerContext,0,0,0);
 }else if(message==DPN_MSGID_INDICATE_CONNECT){DPNMSG_INDICATE_CONNECT *m=data;m->pvPlayerContext=(void*)0xa001;trace(message,m->dwSize,0,(DWORD)m->pvPlayerContext,0,0,0);
 }else if(message==DPN_MSGID_CONNECT_COMPLETE){DPNMSG_CONNECT_COMPLETE *m=data;connect_result=m->hResultCode;trace(message,m->dwSize,m->dpnidLocal,(DWORD)m->pvUserContext,m->hResultCode,m->hAsyncOp,0);InterlockedIncrement(&connect_count);
 }else if(message==DPN_MSGID_PEER_INFO){DPNMSG_PEER_INFO *m=data;DWORD r=normalized(m->dpnidPeer);Query q=query(m->dpnidPeer,r);trace(message,m->dwSize,m->dpnidPeer,(DWORD)m->pvPlayerContext,0,0,&q);if(r<2)InterlockedIncrement(&info_count[r]);else failure=21;
 }else if(message==DPN_MSGID_ASYNC_OP_COMPLETE){DPNMSG_ASYNC_OP_COMPLETE *m=data;completed_handle=m->hAsyncOp;completed_context=(DWORD)m->pvUserContext;async_result=m->hResultCode;trace(message,m->dwSize,0,(DWORD)m->pvUserContext,m->hResultCode,m->hAsyncOp,0);InterlockedIncrement(&async_count);
 }else if(message==DPN_MSGID_DESTROY_PLAYER){DPNMSG_DESTROY_PLAYER *m=data;DWORD r=normalized(m->dpnidPlayer);trace(message,m->dwSize,m->dpnidPlayer,(DWORD)m->pvPlayerContext,m->dwReason,0,0);if(r<2)InterlockedIncrement(&destroyed[r]);else failure=22;}
 return DPN_OK;
}
static void snapshot(DWORD tag,DWORD r){Query q=query(ids[r],r);DWORD n=0;DPN_PLAYER_INFO *empty=0;HRESULT hr=IDirectPlay8Peer_GetPeerInfo(dp,ids[r],empty,&n,0);
 record(tag,hr);record(tag+1,n);record(tag+2,q.hr);record(tag+3,q.size);record(tag+4,q.flags);record(tag+5,q.name_present);record(tag+6,q.name_kind);record(tag+7,q.name_hash);record(tag+8,q.data_present);record(tag+9,q.data_size);record(tag+10,q.data_kind);record(tag+11,q.data_hash);
}
static HRESULT address(IDirectPlay8Address **out,int remote){HRESULT hr;DWORD port=ORACLE_HOST_PORT+(remote?0:role),traversal=0;GUID device={0x4ce725f6,0x7b7f,0x4297,{0xba,0x6f,0x11,0xf9,0x65,0xbc,0x42,0x99}};
 hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)out);if(FAILED(hr))return hr;hr=IDirectPlay8Address_SetSP(*out,&CLSID_DP8SP_TCPIP);if(FAILED(hr))return hr;
 if(remote)hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_HOSTNAME,L"127.0.0.1",20,DPNA_DATATYPE_STRING);else hr=IDirectPlay8Address_SetDevice(*out,&device);if(FAILED(hr))return hr;
 hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_PORT,&port,4,DPNA_DATATYPE_DWORD);if(FAILED(hr))return hr;
 if(!remote)hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_TRAVERSALMODE,&traversal,4,DPNA_DATATYPE_DWORD);return hr;
}
static int perform(DWORD step){DPN_PLAYER_INFO info;HRESULT hr;LONG before=async_count;BYTE mutable_data[4];WCHAR mutable_name[16];DWORD i,flags=DPNSETPEERINFO_SYNC;zero(&info,sizeof(info));info.dwSize=sizeof(info);
 if(step==2){info.dwInfoFlags=DPNINFO_NAME;info.pwszName=updated_name[0];}
 else if(step==3){info.dwInfoFlags=DPNINFO_DATA;info.pvData=updated_data[1];info.dwDataSize=4;flags=0;}
 else if(step==4){info.dwInfoFlags=DPNINFO_NAME;info.pwszName=0;}
 else if(step==5){info.dwInfoFlags=DPNINFO_DATA;info.pvData=0;info.dwDataSize=0;}
 else if(step==6){info.dwInfoFlags=DPNINFO_NAME|DPNINFO_DATA;for(i=0;i<16;i++)mutable_name[i]=0;for(i=0;updated_name[0][i]&&i<15;i++)mutable_name[i]=updated_name[0][i];copy(mutable_data,updated_data[0],4);info.pwszName=mutable_name;info.pvData=mutable_data;info.dwDataSize=4;flags=0;}
 else if(step==7){info.dwInfoFlags=DPNINFO_NAME;info.pwszName=L"";}
 else if(step==8){info.dwInfoFlags=DPNINFO_DATA;info.pvData=updated_data[1];info.dwDataSize=0;}
 else return 0;
 async_handle=0;hr=IDirectPlay8Peer_SetPeerInfo(dp,&info,(void*)(0xb000+step),flags?0:&async_handle,flags);record(100*step+1,hr);record(100*step+2,async_handle!=0);record(100*step+3,async_count-before);
 if(step==6){for(i=0;i<16;i++)mutable_name[i]=0x0058;mutable_name[15]=0;for(i=0;i<4;i++)mutable_data[i]=0xee;}
 if(FAILED(hr))return 0;
 if(hr==DPNSUCCESS_PENDING){if(!wait_count(&async_count,before+1))return 0;record(100*step+4,async_result);record(100*step+5,completed_handle==async_handle);record(100*step+6,completed_context==0xb000+step);if(FAILED(async_result))return 0;}
 return 1;
}
static DWORD WINAPI watchdog(void *unused){DWORD v[4];(void)unused;if(WaitForSingleObject(watchdog_stop,60000)==WAIT_TIMEOUT){v[0]=ORACLE_NONCE;v[1]=role;v[2]=phase;v[3]=failure;file("info-watchdog.bin",v,sizeof(v));ExitProcess(98);}return 0;}
static void run(void){IDirectPlay8Address *device=0,*remote=0;DPN_PLAYER_INFO player;DPN_APPLICATION_DESC app;DPN_CAPS caps;DPNHANDLE connect_handle=0;HRESULT hr;DWORD step,r,actor;LONG before;char path[40];int com_ready=0;
 record(1,role);record(2,sizeof(DPNMSG_PEER_INFO));record(3,sizeof(DPNMSG_ASYNC_OP_COMPLETE));record(4,sizeof(DPN_PLAYER_INFO));
 hr=CoInitialize(0);record(5,hr);if(FAILED(hr)){failure=1;return;}com_ready=1;
 hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&dp);record(6,hr);if(FAILED(hr)){failure=2;goto done;}
 hr=IDirectPlay8Peer_Initialize(dp,(void*)0x9000,handler,0);record(7,hr);if(FAILED(hr)){failure=3;goto done;}
 zero(&caps,sizeof(caps));caps.dwSize=sizeof(caps);caps.dwConnectTimeout=150;caps.dwConnectRetries=10;caps.dwTimeoutUntilKeepAlive=5000;record(8,IDirectPlay8Peer_SetCaps(dp,&caps,0));
 zero(&player,sizeof(player));player.dwSize=sizeof(player);player.dwInfoFlags=DPNINFO_NAME|DPNINFO_DATA;player.pwszName=initial_name[role];player.pvData=initial_data[role];player.dwDataSize=4;
 record(9,IDirectPlay8Peer_SetPeerInfo(dp,&player,0,0,DPNSETPEERINFO_SYNC));
 hr=address(&device,0);record(10,hr);if(FAILED(hr)){failure=4;goto done;}
 zero(&app,sizeof(app));app.dwSize=sizeof(app);app.guidApplication.Data1=ORACLE_NONCE;app.guidApplication.Data2=0x29c1;app.dwMaxPlayers=2;app.pwszSessionName=L"stage29 peer info";
 phase=1;
 if(!role){IDirectPlay8Address *list[4]={0,0,0,0};DWORD count=4,n=4,type=0,port=0,chars=512;WCHAR url[512];
  hr=IDirectPlay8Peer_Host(dp,&app,&device,1,0,0,(void*)0xa000,0);record(11,hr);if(FAILED(hr)){failure=5;goto done;}
  record(12,IDirectPlay8Peer_GetLocalHostAddresses(dp,list,&count,0));record(13,count>0);
  if(list[0]){record(14,IDirectPlay8Address_GetComponentByName(list[0],DPNA_KEY_PORT,&port,&n,&type));record(15,port==ORACLE_HOST_PORT);zero(url,sizeof(url));record(16,IDirectPlay8Address_GetURLW(list[0],url,&chars));if(chars<=512)file("info-host-address-url.bin",url,chars*2);}
  for(r=0;r<count&&r<4;r++)if(list[r])IDirectPlay8Address_Release(list[r]);marker("host-ready.bin");
 }else{hr=address(&remote,1);record(17,hr);if(FAILED(hr)){failure=6;goto done;}app.dwMaxPlayers=0;app.pwszSessionName=0;
  hr=IDirectPlay8Peer_Connect(dp,&app,remote,device,0,0,0,0,(void*)0xa001,(void*)0x9100,&connect_handle,0);record(18,hr);record(19,connect_handle!=0);
  if(hr!=DPNSUCCESS_PENDING||!wait_count(&connect_count,1)||FAILED(connect_result)){failure=7;goto done;}}
 if(!wait_count(&created[0],1)||!wait_count(&created[1],1)){failure=8;goto done;}
 snapshot(40,0);snapshot(60,1);
 {DPN_PLAYER_INFO invalid;DPNHANDLE output=0xeeeeeeee;zero(&invalid,sizeof(invalid));invalid.dwSize=sizeof(invalid);invalid.dwInfoFlags=DPNINFO_NAME;invalid.pwszName=updated_name[role];invalid.pvData=updated_data[role];invalid.dwDataSize=4;
  record(80,IDirectPlay8Peer_SetPeerInfo(dp,&invalid,0,0,DPNSETPEERINFO_SYNC));invalid.dwInfoFlags=DPNINFO_DATA;record(81,IDirectPlay8Peer_SetPeerInfo(dp,&invalid,0,0,DPNSETPEERINFO_SYNC));
  invalid.dwInfoFlags=DPNINFO_NAME;invalid.pvData=0;invalid.dwDataSize=0;record(82,IDirectPlay8Peer_SetPeerInfo(dp,&invalid,0,&output,DPNSETPEERINFO_SYNC));record(83,output==0xeeeeeeee);
  invalid.dwInfoFlags=4;invalid.pwszName=0;record(84,IDirectPlay8Peer_SetPeerInfo(dp,&invalid,0,0,DPNSETPEERINFO_SYNC));}
 marker("connected.bin");
 for(step=2;step<=8;step++){actor=step==3||step==5||step==8?1:0;phase=step;before=info_count[actor];step_path(path,step,"ready.bin");marker(path);step_path(path,step,"go.bin");if(!wait_mark(path)){failure=30+step;goto done;}
  if(role==actor&&!perform(step)){failure=40+step;goto done;}
  if(!wait_count(&info_count[actor],before+1)){failure=50+step;goto done;}
  snapshot(step*100+20,0);snapshot(step*100+40,1);record(step*100+70,info_count[actor]-before);record(step*100+71,async_count);step_path(path,step,"done.bin");marker(path);
 }
 marker("all-steps-done.bin");
 if(role){if(!wait_mark("peer-close-go.bin")){failure=60;goto done;}}
 else{if(!wait_count(&destroyed[1],1)){failure=61;goto done;}marker("host-peer-closed.bin");if(!wait_mark("host-close-go.bin")){failure=62;goto done;}}
 done:
 phase=99;if(dp){record(900,IDirectPlay8Peer_Close(dp,0));IDirectPlay8Peer_Release(dp);dp=0;}phase=100;
 if(remote)IDirectPlay8Address_Release(remote);if(device)IDirectPlay8Address_Release(device);if(com_ready)CoUninitialize();
 Sleep(15);record(901,created[0]);record(902,created[1]);record(903,destroyed[0]);record(904,destroyed[1]);record(905,late);record(906,dropped);record(999,failure);file("lan-oracle.bin",obs,used*4);marker("done.bin");
}
void entry(void){DWORD code;role=contains(GetCommandLineA(),"--peer");InitializeCriticalSection(&trace_lock);watchdog_stop=CreateEventA(0,TRUE,FALSE,0);watchdog_thread=CreateThread(0,0,watchdog,0,0,0);run();code=failure?1:0;SetEvent(watchdog_stop);WaitForSingleObject(watchdog_thread,2000);CloseHandle(watchdog_thread);CloseHandle(watchdog_stop);DeleteCriticalSection(&trace_lock);ExitProcess(code);}
