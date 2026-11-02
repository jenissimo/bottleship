#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <string.h>
static GUID app={0x28314231,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}}, found;
/* Windows x86 oracle: enumerated player properties are visible only inside
 * DPENUMPLAYERS_SESSION callbacks; Open accepts a GUID-instance-only descriptor. */
static DWORD WINAPI watchdog(void *unused) {(void)unused;Sleep(30000);ExitProcess(124);return 0;}
static IDirectPlay4 *client; static DPID seen;
static BOOL CALLBACK player(DPID id,DWORD type,LPCDPNAME name,DWORD flags,LPVOID context) {
 DPCAPS caps; DWORD pf=0; HRESULT h,g; (void)name;(void)context;
 memset(&caps,0,sizeof(caps)); caps.dwSize=sizeof(caps);
 h=IDirectPlayX_GetPlayerCaps(client,id,&caps,0);g=IDirectPlayX_GetPlayerFlags(client,id,&pf);seen=id;
 printf("PLAYER id=%lu type=%lu flags=%lx caps=%08lx playerflags=%08lx\n",(unsigned long)id,(unsigned long)type,(unsigned long)flags,(unsigned long)(DWORD)h,(unsigned long)(DWORD)g);
 return TRUE;
}
static BOOL CALLBACK session(LPCDPSESSIONDESC2 d,LPDWORD t,DWORD f,LPVOID c) {
 (void)t;(void)c;if(f&DPESC_TIMEDOUT)return FALSE;
 if(d&&IsEqualGUID(&d->guidApplication,&app)){found=d->guidInstance;return FALSE;}return TRUE;
}
int main(void){
 IDirectPlayLobby3A *lobby;IDirectPlay4 *host; BYTE address[1024]; DWORD size=sizeof(address); HRESULT hr;
 DPSESSIONDESC2 d;DPNAME n;DPID id=0;DPCAPS caps;setvbuf(stdout,NULL,_IONBF,0);
 if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 9;
 CoInitialize(NULL);
 hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);printf("lobby %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 1;
 hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&size);if(FAILED(hr))return 2;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&host);if(FAILED(hr))return 3;
 hr=IDirectPlayX_InitializeConnection(host,address,0);if(FAILED(hr))return 4;
 memset(&d,0,sizeof(d));d.dwSize=sizeof(d);d.guidApplication=app;d.dwMaxPlayers=8;d.lpszSessionName=(void*)"oracle";
 hr=IDirectPlayX_Open(host,&d,DPOPEN_CREATE);printf("open %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 5;
 memset(&n,0,sizeof(n));n.dwSize=sizeof(n);n.lpszShortName=(void*)"Host";hr=IDirectPlayX_CreatePlayer(host,&id,&n,NULL,NULL,0,0);printf("create %08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)id);if(FAILED(hr))return 6;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4A,(void**)&client);if(FAILED(hr))return 7;
 hr=IDirectPlayX_InitializeConnection(client,address,0);if(FAILED(hr))return 8;
 memset(&d,0,sizeof(d));d.dwSize=sizeof(d);d.guidApplication=app;
 hr=IDirectPlayX_EnumSessions(client,&d,2500,session,NULL,0);printf("sessions %08lx found=%08lx\n",(unsigned long)(DWORD)hr,(unsigned long)found.Data1);
 hr=IDirectPlayX_EnumPlayers(client,&found,player,NULL,DPENUMPLAYERS_SESSION);printf("players %08lx seen=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)seen);
 memset(&caps,0,sizeof(caps));caps.dwSize=sizeof(caps);hr=IDirectPlayX_GetPlayerCaps(client,seen,&caps,0);printf("after_caps %08lx\n",(unsigned long)(DWORD)hr);
 memset(&d,0,sizeof(d));d.dwSize=sizeof(d);d.guidInstance=found;
 hr=IDirectPlayX_Open(client,&d,DPOPEN_JOIN);printf("open_instance_only %08lx\n",(unsigned long)(DWORD)hr);
 { BYTE payload[8]={1,2,3,4};DWORD msg=0;const DWORD cases[]={0,DPSEND_ASYNC,DPSEND_ASYNC|DPSEND_NOSENDCOMPLETEMSG};
   for(int i=0;i<3;i++){hr=IDirectPlayX_SendEx(host,id,DPID_ALLPLAYERS,cases[i],payload,sizeof(payload),0,2000,NULL,NULL);printf("sendex_null flags=%lx hr=%08lx\n",(unsigned long)cases[i],(unsigned long)(DWORD)hr);}
   hr=IDirectPlayX_SendEx(host,id,DPID_ALLPLAYERS,DPSEND_ASYNC|DPSEND_NOSENDCOMPLETEMSG,payload,sizeof(payload),0,2000,NULL,&msg);printf("sendex_id hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)msg);
 }
 IDirectPlayX_Close(client);
 IDirectPlayX_Close(host);IDirectPlayX_Release(host);IDirectPlayX_Release(client);lobby->lpVtbl->Release(lobby);CoUninitialize();return 0;
}