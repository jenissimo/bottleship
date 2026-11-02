#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#include <dplobby8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3;
static GUID application={ORACLE_NONCE,0x7931,0x48c8,{0x90,0x31,0x62,0x43,0x59,0x83,0xb7,0x62}};
static HANDLE received,changed,disconnected;
static DWORD child_mode,creates,connect_ok,connect_address,connect_data,context_ok,receive_value,status_value,settings_ok;
static DWORD reply[24],reply_size;
static void record(DWORD value){oracle_results[count++]=value;}
static void clear_bytes(void *value,DWORD size){BYTE *p=value;while(size--)*p++=0;}
static int equal_guid(const GUID *a,const GUID *b){DWORD i;for(i=0;i<16;i++)if(((BYTE *)a)[i]!=((BYTE *)b)[i])return 0;return 1;}
static void finish(void){
    HANDLE file;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,(const void *)oracle_results,count*4,&written,0);CloseHandle(file);}
    ExitProcess(file==INVALID_HANDLE_VALUE?1:0);
}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
    if(message==DPL_MSGID_CONNECT){
        DPL_MESSAGE_CONNECT *m=data;GUID provider;creates++;
        connect_ok=m->dwSize==sizeof(*m)&&m->pdplConnectionSettings&&m->pdplConnectionSettings->dwFlags==1&&
            m->pdplConnectionSettings->pwszPlayerName&&m->pdplConnectionSettings->pwszPlayerName[0]==0x73a9;
        connect_data=m->dwLobbyConnectDataSize==3&&m->pvLobbyConnectData&&((BYTE *)m->pvLobbyConnectData)[2]==3;
        if(m->pdplConnectionSettings&&m->pdplConnectionSettings->cNumDeviceAddresses){
            IDirectPlay8Address *address=m->pdplConnectionSettings->ppdp8DeviceAddresses[0];
            connect_address=IDirectPlay8Address_GetSP(address,&provider)==S_OK&&equal_guid(&provider,&CLSID_DP8SP_TCPIP);
        }
        m->pvConnectionContext=(void *)0x4455;
    }else if(message==DPL_MSGID_RECEIVE){
        DPL_MESSAGE_RECEIVE *m=data;DWORD i;
        context_ok=m->pvConnectionContext==(void *)(child_mode?0x4455:0x7788)&&context==(void *)(child_mode?0x1122:0x3344);
        receive_value=m->dwBufferSize>=4?*(DWORD *)m->pBuffer:0;
        if(!child_mode){reply_size=m->dwBufferSize;for(i=0;i<24&&i*4<m->dwBufferSize;i++)reply[i]=((DWORD *)m->pBuffer)[i];}
        SetEvent(received);
    }else if(message==DPL_MSGID_SESSION_STATUS){
        DPL_MESSAGE_SESSION_STATUS *m=data;status_value=m->dwStatus;
    }else if(message==DPL_MSGID_CONNECTION_SETTINGS){
        DPL_MESSAGE_CONNECTION_SETTINGS *m=data;
        settings_ok=m->pvConnectionContext==(void *)0x7788&&m->pdplConnectionSettings->pwszPlayerName&&m->pdplConnectionSettings->pwszPlayerName[0]=='C';
        SetEvent(changed);
    }else if(message==DPL_MSGID_DISCONNECT)SetEvent(disconnected);
    return S_OK;
}
static int is_child(void){
    char *line=GetCommandLineA();DWORD i;
    for(i=0;line[i];i++)if(line[i]=='-'&&line[i+1]=='-'&&line[i+2]=='d'&&line[i+3]=='p'&&line[i+4]=='l'&&line[i+5]=='8'&&line[i+6]=='c')return 1;
    return 0;
}
static void release_settings(DPL_CONNECTION_SETTINGS *settings){
    DWORD i;
    if(settings->pdp8HostAddress)IDirectPlay8Address_Release(settings->pdp8HostAddress);
    for(i=0;i<settings->cNumDeviceAddresses;i++)if(settings->ppdp8DeviceAddresses[i])IDirectPlay8Address_Release(settings->ppdp8DeviceAddresses[i]);
}
typedef HRESULT (WINAPI *LobbyCreate)(const GUID *,void **,IUnknown *);
static void run_child(LobbyCreate create){
    IDirectPlay8LobbiedApplication *app=0;IDirectPlay8Peer *peer=0;DPN_PLAYER_INFO info;DPNHANDLE connection=0;DWORD hr,size=0,report[20],ack=0,waited;static BYTE bytes[4096];
    DPL_CONNECTION_SETTINGS *settings=(DPL_CONNECTION_SETTINGS *)bytes;GUID provider;
    child_mode=1;clear_bytes(report,sizeof(report));received=CreateEventA(0,FALSE,FALSE,0);
    if(FAILED(create(&IID_IDirectPlay8LobbiedApplication,(void **)&app,0)))ExitProcess(40);
    report[0]=0x31415926;report[1]=IDirectPlay8LobbiedApplication_Initialize(app,(void *)0x1122,callback,&connection,0);
    report[2]=connection!=0;report[3]=creates;report[4]=connect_ok;report[5]=connect_address;report[6]=connect_data;
    report[7]=WaitForSingleObject(received,8000);report[8]=receive_value;report[9]=context_ok;
    report[10]=IDirectPlay8LobbiedApplication_GetConnectionSettings(app,connection,0,&size,0);report[11]=size;
    size=sizeof(bytes);report[12]=IDirectPlay8LobbiedApplication_GetConnectionSettings(app,connection,settings,&size,0);report[13]=size;
    report[14]=SUCCEEDED(report[12])&&settings->pwszPlayerName&&settings->pwszPlayerName[0]==0x73a9;
    report[15]=SUCCEEDED(report[12])&&settings->cNumDeviceAddresses==1&&
        IDirectPlay8Address_GetSP(settings->ppdp8DeviceAddresses[0],&provider)==0&&equal_guid(&provider,&CLSID_DP8SP_TCPIP);
    if(SUCCEEDED(report[12])){
        report[16]=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void **)&peer);
        if(SUCCEEDED(report[16])){
            report[16]=IDirectPlay8Peer_Initialize(peer,0,callback,0);
            clear_bytes(&info,sizeof(info));info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME;info.pwszName=L"Changed";
            if(SUCCEEDED(report[16]))report[16]=IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNOP_SYNC);
            if(SUCCEEDED(report[16]))report[16]=IDirectPlay8Peer_RegisterLobby(peer,connection,app,DPNLOBBY_REGISTER);
            if(SUCCEEDED(report[16]))report[17]=IDirectPlay8Peer_Host(peer,&settings->dpnAppDesc,settings->ppdp8DeviceAddresses,settings->cNumDeviceAddresses,0,0,0,0);
        }
        release_settings(settings);
    }
    report[18]=GetCurrentProcessId();report[19]=0;
    hr=IDirectPlay8LobbiedApplication_Send(app,connection,(BYTE *)report,sizeof(report),0);
    if(FAILED(hr))ExitProcess(41);
    waited=WaitForSingleObject(received,8000);ack=receive_value;
    if(peer){IDirectPlay8Peer_Close(peer,0);IDirectPlay8Peer_Release(peer);}
    IDirectPlay8LobbiedApplication_Close(app,0);IDirectPlay8LobbiedApplication_Release(app);CloseHandle(received);CoUninitialize();
    ExitProcess(waited==0&&ack==0x87654321?17:42);
}
void entry(void){
    IDirectPlay8LobbyClient *client=0;IDirectPlay8LobbiedApplication *registration=0;IDirectPlay8Address *address=0;
    HMODULE dll;LobbyCreate create;DPL_PROGRAM_DESC program;DPL_CONNECTION_SETTINGS settings;DPL_CONNECT_INFO connect;
    static WCHAR path[1024],directory[1024],filename[256];DWORD length,last=0,i,hr,connection=0,ping=0x12345678,ack=0x87654321,size=0,exitcode=0;
    BYTE connect_data_bytes[3]={1,2,3};static BYTE bytes[4096];HANDLE process=0;BOOL registered=FALSE;
    CoInitialize(0);dll=LoadLibraryA("dpnlobby.dll");if(!dll)finish();
    create=(LobbyCreate)GetProcAddress(dll,"DirectPlay8LobbyCreate");if(!create)finish();
    if(is_child())run_child(create);
    record(create(&IID_IDirectPlay8LobbyClient,(void **)&client,0));if(!client)finish();
    record(create(&IID_IDirectPlay8LobbiedApplication,(void **)&registration,0));if(!registration)goto cleanup;
    received=CreateEventA(0,FALSE,FALSE,0);changed=CreateEventA(0,FALSE,FALSE,0);disconnected=CreateEventA(0,FALSE,FALSE,0);
    record(IDirectPlay8LobbyClient_Initialize(client,(void *)0x3344,callback,0));
    length=GetModuleFileNameW(0,path,1024);for(i=0;i<length;i++)if(path[i]=='\\'||path[i]=='/')last=i+1;
    for(i=0;i<last;i++)directory[i]=path[i];directory[last]=0;for(i=last;i<=length;i++)filename[i-last]=path[i];
    clear_bytes(&program,sizeof(program));program.dwSize=sizeof(program);program.guidApplication=application;
    program.pwszApplicationName=L"BottleShip DP8 process oracle";program.pwszExecutableFilename=filename;program.pwszExecutablePath=directory;
    program.pwszCommandLine=L"--dpl8child";program.pwszCurrentDirectory=directory;
    hr=IDirectPlay8LobbiedApplication_RegisterProgram(registration,&program,0);record(hr);if(FAILED(hr))goto cleanup;registered=TRUE;
    hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void **)&address);record(hr);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8Address_SetSP(address,&CLSID_DP8SP_TCPIP));
    clear_bytes(&settings,sizeof(settings));settings.dwSize=sizeof(settings);settings.dwFlags=DPLCONNECTSETTINGS_HOST;
    settings.dpnAppDesc.dwSize=sizeof(DPN_APPLICATION_DESC);settings.dpnAppDesc.guidApplication=application;
    settings.dpnAppDesc.dwMaxPlayers=8;settings.dpnAppDesc.pwszSessionName=L"Лан";settings.pwszPlayerName=L"玩家";
    settings.ppdp8DeviceAddresses=&address;settings.cNumDeviceAddresses=1;
    clear_bytes(&connect,sizeof(connect));connect.dwSize=sizeof(connect);connect.dwFlags=DPLCONNECT_LAUNCHNEW;
    connect.guidApplication=application;connect.pdplConnectionSettings=&settings;connect.pvLobbyConnectData=connect_data_bytes;connect.dwLobbyConnectDataSize=3;
    hr=IDirectPlay8LobbyClient_ConnectApplication(client,&connect,(void *)0x7788,&connection,8000,0);record(hr);record(connection!=0);if(FAILED(hr))goto cleanup;
    record(IDirectPlay8LobbyClient_GetConnectionSettings(client,connection,0,&size,0));record(size);
    size=sizeof(bytes);hr=IDirectPlay8LobbyClient_GetConnectionSettings(client,connection,(DPL_CONNECTION_SETTINGS *)bytes,&size,0);record(hr);record(size);
    if(SUCCEEDED(hr)){DPL_CONNECTION_SETTINGS *copy=(DPL_CONNECTION_SETTINGS *)bytes;record(copy->pwszPlayerName&&copy->pwszPlayerName[0]==0x73a9);release_settings(copy);}
    record(IDirectPlay8LobbyClient_Send(client,connection,(BYTE *)&ping,4,0));
    hr=WaitForSingleObject(received,8000);record(hr);
    if(hr==0){
        record(reply_size);for(i=0;i<18;i++)record(reply[i]);record(reply[18]!=0&&reply[18]!=GetCurrentProcessId());record(context_ok);
        process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_INFORMATION,FALSE,reply[18]);record(process!=0);
        record(WaitForSingleObject(changed,8000));record(settings_ok);record(status_value);
        record(IDirectPlay8LobbyClient_Send(client,connection,(BYTE *)&ack,4,0));
        record(WaitForSingleObject(disconnected,8000));
        if(process){record(WaitForSingleObject(process,8000));record(GetExitCodeProcess(process,&exitcode));record(exitcode);CloseHandle(process);}
    }
cleanup:
    if(registered)record(IDirectPlay8LobbiedApplication_UnRegisterProgram(registration,&application,0));
    if(address)IDirectPlay8Address_Release(address);
    if(registration)IDirectPlay8LobbiedApplication_Release(registration);
    if(client){record(IDirectPlay8LobbyClient_Close(client,0));IDirectPlay8LobbyClient_Release(client);}
    if(received)CloseHandle(received);if(changed)CloseHandle(changed);if(disconnected)CloseHandle(disconnected);
    CoUninitialize();finish();
}
