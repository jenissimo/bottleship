#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static GUID app={0,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}}, found;
static int matches;
static DWORD WINAPI watchdog(void *p){(void)p;Sleep(20000);ExitProcess(124);return 0;}
static BOOL CALLBACK on_enum(LPCDPSESSIONDESC2 d,LPDWORD t,DWORD f,LPVOID p){
 (void)t;(void)p;if(f&DPESC_TIMEDOUT)return FALSE;
 if(d&&IsEqualGUID(&d->guidApplication,&app)){found=d->guidInstance;matches++;return FALSE;}return TRUE;
}
int main(int argc,char **argv){
 IDirectPlayLobby3A *lobby=NULL;IDirectPlay4 *dp=NULL;BYTE addr[1024];DWORD n=sizeof(addr);char *end;HRESULT hr;
 DPSESSIONDESC2 desc;unsigned long nonce;
 if(argc!=2)return 2;nonce=strtoul(argv[1],&end,10);if(!nonce||*end)return 2;app.Data1=(DWORD)nonce;
 setvbuf(stdout,NULL,_IONBF,0);if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 3;
 printf("PID %lu NONCE %lu\n",(unsigned long)GetCurrentProcessId(),nonce);
 hr=CoInitialize(NULL);printf("COINIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 4;
 hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);
 printf("LOBBY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 5;
 hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,addr,&n);
 printf("ADDRESS %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 6;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4,(void**)&dp);
 printf("FACTORY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 7;
 hr=IDirectPlayX_InitializeConnection(dp,addr,0);printf("INIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 8;
 memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;
 hr=IDirectPlayX_EnumSessions(dp,&desc,2500,on_enum,NULL,0);printf("ENUM %08lx matches=%d\n",(unsigned long)(DWORD)hr,matches);
 if(FAILED(hr)||matches!=1)return 9;
 memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;desc.guidInstance=found;
 hr=IDirectPlayX_Open(dp,&desc,DPOPEN_JOIN);printf("OPEN_JOIN %08lx\n",(unsigned long)(DWORD)hr);
 if(SUCCEEDED(hr)){
  DPNAME name;DPID id=0;memset(&name,0,sizeof(name));name.dwSize=sizeof(name);name.lpszShortName=L"owned-client";
  HRESULT create=IDirectPlayX_CreatePlayer(dp,&id,&name,NULL,NULL,0,0);printf("CREATE_PLAYER %08lx id=%lu\n",(unsigned long)(DWORD)create,(unsigned long)id);
  if(SUCCEEDED(create)){HRESULT destroy=IDirectPlayX_DestroyPlayer(dp,id);printf("DESTROY_PLAYER %08lx\n",(unsigned long)(DWORD)destroy);}
  HRESULT close=IDirectPlayX_Close(dp);printf("CLOSE %08lx\n",(unsigned long)(DWORD)close);
 }
 IDirectPlayX_Release(dp);lobby->lpVtbl->Release(lobby);CoUninitialize();return 0;
}
