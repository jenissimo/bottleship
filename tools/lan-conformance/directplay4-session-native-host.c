#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay.h>
#include <dplobby.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
/* Owned finite native host; no global capture or service control. */
static DWORD WINAPI watchdog(void *unused){(void)unused;Sleep(30000);ExitProcess(124);return 0;}
int main(int argc,char **argv){
 IDirectPlayLobby3A *lobby=NULL;IDirectPlay4 *play=NULL;BYTE address[1024],descbuf[4096];DWORD size=sizeof(address),nonce,n,written;
 DPSESSIONDESC2 desc,*actual;DPNAME name;DPID player=0,temp=0,late=0,live=0;HRESULT hr;HANDLE file;char *end;int rc=1;GUID app={0,0x7319,0x4ae1,{0xa3,0x92,0x80,0x47,0x31,0x2f,0x9a,0xd1}};
 if(argc!=3)return 2;nonce=(DWORD)strtoul(argv[1],&end,10);if(!nonce||*end)return 2;
 setvbuf(stdout,NULL,_IONBF,0);if(!CreateThread(NULL,0,watchdog,NULL,0,NULL))return 3;
 app.Data1=nonce;printf("PID %lu NONCE %lu\n",(unsigned long)GetCurrentProcessId(),(unsigned long)nonce);
 hr=CoInitialize(NULL);printf("COINIT %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))return 4;
 hr=CoCreateInstance(&CLSID_DirectPlayLobby,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlayLobby3A,(void**)&lobby);if(FAILED(hr))goto done;
 hr=lobby->lpVtbl->CreateAddress(lobby,&DPSPGUID_TCPIP,&DPAID_INet,"127.0.0.1",10,address,&size);if(FAILED(hr))goto done;
 hr=CoCreateInstance(&CLSID_DirectPlay,NULL,CLSCTX_INPROC_SERVER,&IID_IDirectPlay4,(void**)&play);if(FAILED(hr))goto done;
 hr=IDirectPlayX_InitializeConnection(play,address,0);if(FAILED(hr))goto done;
 memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.guidApplication=app;desc.dwMaxPlayers=8;desc.lpszSessionName=L"DP4-channel-oracle";
 hr=IDirectPlayX_Open(play,&desc,DPOPEN_CREATE);printf("OPEN %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))goto done;
 memset(&name,0,sizeof(name));name.dwSize=sizeof(name);name.lpszShortName=L"Host";
 hr=IDirectPlayX_CreatePlayer(play,&player,&name,NULL,NULL,0,0);printf("CREATE %08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)player);if(FAILED(hr)||!player)goto done;
 size=sizeof(descbuf);hr=IDirectPlayX_GetSessionDesc(play,descbuf,&size);if(FAILED(hr)||size<sizeof(DPSESSIONDESC2))goto done;
 actual=(DPSESSIONDESC2*)descbuf;
 { BYTE record[36];DWORD magic=0x43485044,pid=GetCurrentProcessId();memcpy(record,&magic,4);memcpy(record+4,&nonce,4);memcpy(record+8,&pid,4);memcpy(record+12,&player,4);memcpy(record+16,&actual->guidInstance,16);memcpy(record+32,&actual->dwReserved1,4);
  file=CreateFileA(argv[2],GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(file==INVALID_HANDLE_VALUE)goto done;
  n=WriteFile(file,record,sizeof(record),&written,NULL);CloseHandle(file);if(!n||written!=sizeof(record))goto done;
 }
 printf("READY\n");
 /* Query only an ID supplied by our coordinator; watchdog bounds abandonment. */
 {char cmd[96];while(fgets(cmd,sizeof(cmd),stdin)){
   if(cmd[0]=='Q')break;
   if(cmd[0]=='C'){
    DPNAME n;memset(&n,0,sizeof(n));n.dwSize=sizeof(n);n.lpszShortName=L"Temporary";
    hr=IDirectPlayX_CreatePlayer(play,&temp,&n,NULL,NULL,0,0);
    printf("TEMP_CREATE hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)temp);if(FAILED(hr)||!temp)goto done;
   }else if(cmd[0]=='N'){
    DPNAME n;memset(&n,0,sizeof(n));n.dwSize=sizeof(n);n.lpszShortName=L"Late";
    hr=IDirectPlayX_CreatePlayer(play,&late,&n,NULL,NULL,0,0);
    printf("LATE_CREATE hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)late);if(FAILED(hr)||!late)goto done;
   }else if(cmd[0]=='T'){
    DPNAME n;BYTE playerData[]={0x12,0x34,0x56,0x78};memset(&n,0,sizeof(n));n.dwSize=sizeof(n);n.lpszShortName=L"Live";n.lpszLongName=L"Live Long";
    hr=IDirectPlayX_CreatePlayer(play,&live,&n,NULL,playerData,sizeof(playerData),0);
    printf("LIVE_CREATE hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)live);if(FAILED(hr)||!live)goto done;
    {DWORD bytes=sizeof(descbuf);hr=IDirectPlayX_GetSessionDesc(play,descbuf,&bytes);if(FAILED(hr))goto done;printf("LIVE_COUNT phase=C current=%lu\n",(unsigned long)((DPSESSIONDESC2*)descbuf)->dwCurrentPlayers);}
   }else if(cmd[0]=='Y'){
    DPID id=(DPID)strtoul(cmd+1,NULL,10);if(!live||id!=live)goto done;
    hr=IDirectPlayX_DestroyPlayer(play,live);printf("LIVE_DELETE hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)live);
    if(FAILED(hr))goto done;live=0;
    {DWORD bytes=sizeof(descbuf);hr=IDirectPlayX_GetSessionDesc(play,descbuf,&bytes);if(FAILED(hr))goto done;printf("LIVE_COUNT phase=D current=%lu\n",(unsigned long)((DPSESSIONDESC2*)descbuf)->dwCurrentPlayers);}
   }else if(cmd[0]=='X'){
    DPID id=(DPID)strtoul(cmd+1,NULL,10);if(!temp||id!=temp)goto done;
    hr=IDirectPlayX_DestroyPlayer(play,temp);printf("TEMP_DELETE hr=%08lx id=%lu\n",(unsigned long)(DWORD)hr,(unsigned long)temp);
    if(FAILED(hr))goto done;temp=0;
   }else if(cmd[0]=='G'||cmd[0]=='H'){
    DWORD bytes=sizeof(descbuf);hr=IDirectPlayX_GetSessionDesc(play,descbuf,&bytes);
    printf("%s_COUNT hr=%08lx current=%lu\n",cmd[0]=='G'?"HOST":"LATE",(unsigned long)(DWORD)hr,(unsigned long)(SUCCEEDED(hr)?((DPSESSIONDESC2*)descbuf)->dwCurrentPlayers:0));
    if(FAILED(hr))goto done;
   }else if(cmd[0]=='F'){
    DPID guest=(DPID)strtoul(cmd+1,NULL,10);DWORD hf=0,lf=0,gf=0;
    HRESULT a=IDirectPlayX_GetPlayerFlags(play,player,&hf),b=IDirectPlayX_GetPlayerFlags(play,late,&lf),c=IDirectPlayX_GetPlayerFlags(play,guest,&gf);
    printf("PLAYER_FLAGS host=%08lx late=%08lx guest=%08lx hr=%08lx,%08lx,%08lx\n",(unsigned long)hf,(unsigned long)lf,(unsigned long)gf,(unsigned long)(DWORD)a,(unsigned long)(DWORD)b,(unsigned long)(DWORD)c);
    if(FAILED(a)||FAILED(b)||FAILED(c))goto done;
   }else if(cmd[0]=='P'){
    DWORD id=(DWORD)strtoul(cmd+1,NULL,10),start=GetTickCount(),bytes;BYTE playername[2048];HRESULT q;
    do{bytes=sizeof(playername);q=IDirectPlayX_GetPlayerName(play,id,playername,&bytes);if(SUCCEEDED(q))break;Sleep(10);}while((DWORD)(GetTickCount()-start)<4000);
    {int match=0;if(SUCCEEDED(q)&&bytes>=sizeof(DPNAME)){const DPNAME *d=(const DPNAME*)playername;uintptr_t ptr=(uintptr_t)d->lpszShortName,base=(uintptr_t)playername;static const WCHAR expected[]=L"owned-client";if(ptr>=base&&ptr-base<=sizeof(playername)-sizeof(expected))match=!memcmp((void*)ptr,expected,sizeof(expected));}
     printf("QUERY id=%lu hr=%08lx size=%lu nameok=%d\n",(unsigned long)id,(unsigned long)(DWORD)q,(unsigned long)bytes,match);
    }
   }else if(cmd[0]=='D'||cmd[0]=='I'){
    DWORD id=(DWORD)strtoul(cmd+1,NULL,10),start=GetTickCount(),bytes;BYTE namebuf[2048];HRESULT q;
    do{bytes=sizeof(namebuf);q=IDirectPlayX_GetPlayerName(play,id,namebuf,&bytes);if(cmd[0]=='I'||FAILED(q))break;Sleep(10);}while((DWORD)(GetTickCount()-start)<4000);
    printf("INSPECT mode=%c id=%lu hr=%08lx size=%lu\n",cmd[0],(unsigned long)id,(unsigned long)(DWORD)q,(unsigned long)bytes);
   }else if(cmd[0]=='R'){
    unsigned long target=0,count=0,i;DPID expected,from=0,to=0;DWORD until=GetTickCount()+6000,bytes=0;BYTE payload[4096];char wanted[64],reply[64];
    if(sscanf(cmd+1,"%lu %lu",&target,&count)<1||!target||count>300)goto done;expected=(DPID)target;
    int want=snprintf(wanted,sizeof(wanted),"client-%lu",(unsigned long)nonce),got=0;HRESULT recvhr=DPERR_NOMESSAGES;
    while((LONG)(GetTickCount()-until)<0){from=to=0;bytes=sizeof(payload);recvhr=IDirectPlayX_Receive(play,&from,&to,DPRECEIVE_ALL,payload,&bytes);
     if(recvhr==DPERR_NOMESSAGES){Sleep(10);continue;}if(FAILED(recvhr))break;
     if(from==expected&&to==player&&bytes==(DWORD)want&&!memcmp(payload,wanted,want)){got=1;break;}
    }
    printf("RECV ok=%d hr=%08lx from=%lu to=%lu size=%lu\n",got,(unsigned long)(DWORD)recvhr,(unsigned long)from,(unsigned long)to,(unsigned long)bytes);
    if(got){int len=snprintf(reply,sizeof(reply),"host-%lu",(unsigned long)nonce);HRESULT sent=IDirectPlayX_Send(play,player,expected,DPSEND_GUARANTEED,reply,(DWORD)len);
     printf("SEND hr=%08lx from=%lu to=%lu size=%d\n",(unsigned long)(DWORD)sent,(unsigned long)player,(unsigned long)expected,len);if(FAILED(sent))goto done;
     for(i=0;i<count;i++){len=snprintf(reply,sizeof(reply),"burst-%lu-%lu",(unsigned long)nonce,i);sent=IDirectPlayX_Send(play,player,expected,DPSEND_GUARANTEED,reply,(DWORD)len);if(FAILED(sent)){hr=sent;goto done;}}
     printf("BURST count=%lu hr=00000000\n",count);}
   }else goto done;
  }} 
 if(live){hr=IDirectPlayX_DestroyPlayer(play,live);if(FAILED(hr))goto done;live=0;}
 if(temp){hr=IDirectPlayX_DestroyPlayer(play,temp);if(FAILED(hr))goto done;temp=0;}
 if(late){hr=IDirectPlayX_DestroyPlayer(play,late);if(FAILED(hr))goto done;late=0;}
 hr=IDirectPlayX_DestroyPlayer(play,player);printf("DESTROY %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))goto done;
 hr=IDirectPlayX_Close(play);printf("CLOSE %08lx\n",(unsigned long)(DWORD)hr);if(FAILED(hr))goto done;
 rc=0;
done:
 if(rc)printf("ERROR %08lx\n",(unsigned long)(DWORD)hr);
 if(play)IDirectPlayX_Release(play);if(lobby)lobby->lpVtbl->Release(lobby);CoUninitialize();return rc;
}
