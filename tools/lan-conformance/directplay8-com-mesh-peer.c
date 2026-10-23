/* Finite Windows DP8 counterpart for an external Core participant. Actual peer
 * ports are recorded so a relay's physical binding is measured independently.
 * This shares the finite native-only reference structure. Each role has separate durable
 * observations and packet-call traces. The IAT hook observes this fixture's
 * loaded provider only; it preserves parameters, return value and Winsock error.
 * It never changes the native DLL on disk or rewrites native wire packets. */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <objbase.h>
#include <dplay8.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifndef ORACLE_HOST_PORT
#define ORACLE_HOST_PORT 45100
#endif
#define TRACE_LIMIT 512
#define TRACE_BYTES 4096
#define TRACE_WORDS 27
static IDirectPlay8Peer *peer;
static DWORD observations[512], observation_count=3, role, phase, failure;
static volatile DWORD known_mask, ids[3], creates[3], destroys[3], received[3], invalid_receives, late_callbacks;
static CRITICAL_SECTION callback_lock;
static const WCHAR *names[3]={L"host",L"peer1",L"peer2"};
static const DWORD ports[3]={ORACLE_HOST_PORT,ORACLE_HOST_PORT+1,ORACLE_HOST_PORT+2};
typedef struct PacketTrace { DWORD words[TRACE_WORDS]; BYTE bytes[TRACE_BYTES]; } PacketTrace;
static PacketTrace trace[TRACE_LIMIT];
static volatile LONG trace_count;
static DWORD hook_installed;
typedef int (WSAAPI *SendToFunction)(SOCKET,LPWSABUF,DWORD,LPDWORD,DWORD,const struct sockaddr*,int,LPWSAOVERLAPPED,LPWSAOVERLAPPED_COMPLETION_ROUTINE);
static SendToFunction original_send;
static DWORD *patched_slot;
static DWORD old_slot;
static int equal_w(const WCHAR *a,const WCHAR *b){if(!a||!b)return 0;while(*a&&*b&&*a==*b){a++;b++;}return *a==*b;}
static int contains(const char *text,const char *part){const char *a,*b;while(*text){a=text;b=part;while(*a&&*b&&*a==*b){a++;b++;}if(!*b)return 1;text++;}return 0;}
static void write_words(const char *path,const DWORD *words,DWORD size){
    HANDLE file;DWORD wrote;
    file=CreateFileA(path,GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,words,size*4,&wrote,0);CloseHandle(file);}
}
static void flush(void){
    observations[0]=0x42534c4e;observations[1]=observation_count;observations[2]=ORACLE_NONCE;
    write_words("mesh-progress.bin",observations,observation_count);
}
static void record(DWORD value){if(observation_count<512)observations[observation_count++]=value;flush();}
static void marker(const char *path){DWORD value=ORACLE_NONCE;write_words(path,&value,1);}
static int marked(const char *path){
    HANDLE file;DWORD value=0,read=0;
    file=CreateFileA(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);
    if(file==INVALID_HANDLE_VALUE)return 0;
    ReadFile(file,&value,4,&read,0);CloseHandle(file);return read==4&&value==ORACLE_NONCE;
}
static int wait_marker(const char *path){DWORD begin=GetTickCount();while(!marked(path)){if(GetTickCount()-begin>10000)return 0;Sleep(5);}return 1;}
static int wait_mask(DWORD mask){DWORD begin=GetTickCount();while((known_mask&mask)!=mask){if(GetTickCount()-begin>7000)return 0;Sleep(1);}return 1;}
static int role_of(DWORD id){DWORD i;for(i=0;i<3;i++)if(ids[i]==id)return (int)i;return -1;}
static int WSAAPI traced_send(SOCKET socket,LPWSABUF buffers,DWORD count,LPDWORD sent,DWORD flags,const struct sockaddr *to,int to_size,LPWSAOVERLAPPED overlapped,LPWSAOVERLAPPED_COMPLETION_ROUTINE completion){
    DWORD index,i,j,copied=0,bytes=0;int saved=WSAGetLastError(),size,result,error;SOCKADDR_STORAGE local;
    size=sizeof(local);for(i=0;i<sizeof(local);i++)((BYTE*)&local)[i]=0;
    getsockname(socket,(struct sockaddr*)&local,&size);WSASetLastError(saved);
    index=(DWORD)InterlockedIncrement(&trace_count)-1;
    if(index<TRACE_LIMIT){
        PacketTrace *item=&trace[index];
        for(i=0;i<count;i++){
            bytes+=buffers[i].len;
            for(j=0;j<buffers[i].len&&copied<TRACE_BYTES;j++)item->bytes[copied++]=(BYTE)buffers[i].buf[j];
        }
        item->words[0]=GetTickCount();item->words[1]=GetCurrentThreadId();item->words[2]=(DWORD)socket;
        item->words[3]=local.ss_family==AF_INET?((struct sockaddr_in*)&local)->sin_addr.s_addr:0;
        item->words[4]=ntohs(((struct sockaddr_in*)&local)->sin_port);
        item->words[13]=local.ss_family;item->words[14]=to?to->sa_family:0;item->words[15]=(DWORD)size;item->words[16]=(DWORD)to_size;
        if(local.ss_family==AF_INET6){for(i=0;i<16;i++)((BYTE*)&item->words[17])[i]=((struct sockaddr_in6*)&local)->sin6_addr.u.Byte[i];item->words[25]=((struct sockaddr_in6*)&local)->sin6_scope_id;}
        if(to&&to_size>=(int)sizeof(struct sockaddr_in6)&&to->sa_family==AF_INET6){for(i=0;i<16;i++)((BYTE*)&item->words[21])[i]=((const struct sockaddr_in6*)to)->sin6_addr.u.Byte[i];item->words[26]=((const struct sockaddr_in6*)to)->sin6_scope_id;}
        item->words[5]=to&&to_size>=(int)sizeof(struct sockaddr_in)&&to->sa_family==AF_INET?((const struct sockaddr_in*)to)->sin_addr.s_addr:0;
        item->words[6]=to&&to_size>=(int)sizeof(struct sockaddr_in)?ntohs(((const struct sockaddr_in*)to)->sin_port):0;
        item->words[7]=bytes;item->words[8]=copied;item->words[9]=flags;item->words[10]=overlapped!=0;
    }
    result=original_send(socket,buffers,count,sent,flags,to,to_size,overlapped,completion);error=WSAGetLastError();
    if(index<TRACE_LIMIT){trace[index].words[11]=(DWORD)result;trace[index].words[12]=(DWORD)error;}
    WSASetLastError(error);return result;
}
static void install_hook(void){
    BYTE *base=(BYTE*)GetModuleHandleA("dpnet.dll");IMAGE_DOS_HEADER *dos;IMAGE_NT_HEADERS32 *nt;IMAGE_IMPORT_DESCRIPTOR *descriptor;DWORD protection;DWORD *slot;
    union { FARPROC raw; SendToFunction typed; } function;
    function.raw=GetProcAddress(GetModuleHandleA("ws2_32.dll"),"WSASendTo");original_send=function.typed;
    if(!base||!original_send)return;
    dos=(IMAGE_DOS_HEADER*)base;if(dos->e_magic!=IMAGE_DOS_SIGNATURE)return;
    nt=(IMAGE_NT_HEADERS32*)(base+dos->e_lfanew);if(nt->Signature!=IMAGE_NT_SIGNATURE)return;
    descriptor=(IMAGE_IMPORT_DESCRIPTOR*)(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    for(;descriptor->Name;descriptor++)for(slot=(DWORD*)(base+descriptor->FirstThunk);*slot;slot++){
        if(*slot!=(DWORD)original_send)continue;
        if(!VirtualProtect(slot,4,PAGE_READWRITE,&protection))return;
        old_slot=*slot;patched_slot=slot;InterlockedExchange((LONG*)slot,(LONG)traced_send);VirtualProtect(slot,4,protection,&protection);hook_installed=1;return;
    }
}
static void flush_trace(void){
    HANDLE file;DWORD wrote,header[9],total=(DWORD)trace_count,state[18],i;
    if(total>TRACE_LIMIT)total=TRACE_LIMIT;
    header[0]=0x42534d54;header[1]=3;header[2]=ORACLE_NONCE;header[3]=role;header[4]=hook_installed;
    header[5]=total;header[6]=(DWORD)trace_count-total;header[7]=TRACE_WORDS;header[8]=TRACE_BYTES;
    file=CreateFileA("mesh-wire.bin",GENERIC_WRITE,FILE_SHARE_READ,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,header,sizeof(header),&wrote,0);WriteFile(file,trace,total*sizeof(trace[0]),&wrote,0);CloseHandle(file);}
    state[0]=0x42534d53;state[1]=ORACLE_NONCE;state[2]=role;state[3]=known_mask;state[4]=invalid_receives;state[5]=late_callbacks;
    for(i=0;i<3;i++){state[6+i]=ids[i];state[9+i]=creates[i];state[12+i]=destroys[i];state[15+i]=received[i];}
    write_words("mesh-state.bin",state,18);
}
static DWORD WINAPI watchdog(void *unused){
    (void)unused;Sleep(25000);marker("mesh-watchdog.bin");flush();flush_trace();ExitProcess(98);return 0;
}
static void remove_hook(void){
    DWORD protection;
    if(patched_slot&&VirtualProtect(patched_slot,4,PAGE_READWRITE,&protection)){
        InterlockedExchange((LONG*)patched_slot,(LONG)old_slot);VirtualProtect(patched_slot,4,protection,&protection);patched_slot=0;
    }
}
static HRESULT WINAPI callback(void *context,DWORD message,void *data){
    DWORD i;int source=-1;HRESULT hr;BYTE storage[256];DPN_PLAYER_INFO *info=(DPN_PLAYER_INFO*)storage;DWORD size=sizeof(storage);(void)context;
    if(message==DPN_MSGID_CREATE_PLAYER){
        DPNMSG_CREATE_PLAYER *m=data;for(i=0;i<sizeof(storage);i++)storage[i]=0;info->dwSize=sizeof(*info);
        hr=IDirectPlay8Peer_GetPeerInfo(peer,m->dpnidPlayer,info,&size,0);
        if(SUCCEEDED(hr))for(i=0;i<3;i++)if(equal_w(info->pwszName,names[i]))source=(int)i;
        EnterCriticalSection(&callback_lock);
        if(source>=0){ids[source]=m->dpnidPlayer;creates[source]++;known_mask|=1u<<source;m->pvPlayerContext=(void*)(0x1000+source);}
        else invalid_receives++;
        LeaveCriticalSection(&callback_lock);
    }else if(message==DPN_MSGID_RECEIVE){
        DPNMSG_RECEIVE *m=data;EnterCriticalSection(&callback_lock);
        source=role_of(m->dpnidSender);
        if(source<0||m->dwReceiveDataSize!=4||m->pReceiveData[0]!=0x4d||m->pReceiveData[1]!=(BYTE)source||m->pReceiveData[2]!=0x37||m->pReceiveData[3]!=(BYTE)(source^0x5a))invalid_receives++;
        else received[source]++;
        LeaveCriticalSection(&callback_lock);
    }else if(message==DPN_MSGID_DESTROY_PLAYER){
        DPNMSG_DESTROY_PLAYER *m=data;EnterCriticalSection(&callback_lock);source=role_of(m->dpnidPlayer);if(source>=0)destroys[source]++;else invalid_receives++;LeaveCriticalSection(&callback_lock);
    }
    if(phase==3)InterlockedIncrement((LONG*)&late_callbacks);
    return S_OK;
}
static HRESULT address(IDirectPlay8Address **out,const WCHAR *host,DWORD port){
    HRESULT hr=CoCreateInstance(&CLSID_DirectPlay8Address,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Address,(void**)out);
    DWORD size=0,traversal=0;
    const GUID loopback={0x4ce725f6,0x7b7f,0x4297,{0xba,0x6f,0x11,0xf9,0x65,0xbc,0x42,0x99}};
    if(FAILED(hr))return hr;
    hr=IDirectPlay8Address_SetSP(*out,&CLSID_DP8SP_TCPIP);if(FAILED(hr))return hr;
    if(host){while(host[size])size++;hr=IDirectPlay8Address_AddComponent(*out,L"hostname",host,(size+1)*2,DPNA_DATATYPE_STRING);if(FAILED(hr))return hr;}
    else{
        /* NT5 ipaddress.h encodes a device sockaddr using the IP SP GUID mask. */
        hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_DEVICE,&loopback,sizeof(loopback),DPNA_DATATYPE_GUID);if(FAILED(hr))return hr;
    }
    hr=IDirectPlay8Address_AddComponent(*out,DPNA_KEY_TRAVERSALMODE,&traversal,4,DPNA_DATATYPE_DWORD);if(FAILED(hr))return hr;
    return IDirectPlay8Address_AddComponent(*out,L"port",&port,4,DPNA_DATATYPE_DWORD);
}
void entry(void){
    IDirectPlay8Address *device=0,*host_address=0,*remote=0;DPN_APPLICATION_DESC desc;DPN_PLAYER_INFO info;DPN_BUFFER_DESC buffer;
    BYTE payload[4],app_storage[256];DPN_CAPS caps;HANDLE timer;DWORD i,size,context,port,type,begin,callback_total;HRESULT hr=S_OK;
    const char *command=GetCommandLineA();role=contains(command,"--peer1")?1:contains(command,"--peer2")?2:0;
    InitializeCriticalSection(&callback_lock);timer=CreateThread(0,0,watchdog,0,0,0);if(timer)CloseHandle(timer);record(role);record(CoInitialize(0));
    hr=CoCreateInstance(&CLSID_DirectPlay8Peer,0,CLSCTX_INPROC_SERVER,&IID_IDirectPlay8Peer,(void**)&peer);record(hr);if(FAILED(hr)){failure=1;goto done;}
    hr=IDirectPlay8Peer_Initialize(peer,0,callback,0);record(hr);if(FAILED(hr)){failure=12;goto done;}install_hook();
    for(i=0;i<sizeof(caps);i++)((BYTE*)&caps)[i]=0;caps.dwSize=sizeof(caps);caps.dwConnectTimeout=150;caps.dwConnectRetries=10;caps.dwTimeoutUntilKeepAlive=10000;
    hr=IDirectPlay8Peer_SetCaps(peer,&caps,0);record(hr);if(FAILED(hr)){failure=13;goto done;}
    for(i=0;i<sizeof(info);i++)((BYTE*)&info)[i]=0;info.dwSize=sizeof(info);info.dwInfoFlags=DPNINFO_NAME;info.pwszName=(WCHAR*)names[role];
    hr=IDirectPlay8Peer_SetPeerInfo(peer,&info,0,0,DPNSETPEERINFO_SYNC);record(hr);if(FAILED(hr)){failure=2;goto done;}
    hr=address(&device,0,ports[role]);record(hr);if(FAILED(hr)){failure=3;goto done;}
    for(i=0;i<sizeof(desc);i++)((BYTE*)&desc)[i]=0;desc.dwSize=sizeof(desc);desc.guidApplication.Data1=ORACLE_NONCE;desc.guidApplication.Data2=0x75e1;desc.dwMaxPlayers=3;
    phase=1;
    if(!role){desc.pwszSessionName=L"Native mesh";hr=IDirectPlay8Peer_Host(peer,&desc,&device,1,0,0,(void*)(0x1000+role),0);}
    else{hr=address(&host_address,L"127.0.0.1",ports[0]);record(hr);if(FAILED(hr)){failure=4;goto done;}hr=IDirectPlay8Peer_Connect(peer,&desc,host_address,device,0,0,0,0,(void*)(0x1000+role),0,0,DPNCONNECT_SYNC);}
    record(hr);if(FAILED(hr)){failure=5;goto done;}
    record(wait_mask(role?3:1));if((known_mask&(role?3:1))!=(role?3u:1u)){failure=6;goto done;}
    marker("mesh-ready.bin");
    record(wait_mask(7));if((known_mask&7)!=7){failure=7;goto done;}
    record(known_mask);for(i=0;i<3;i++){record(creates[i]);context=0;record(IDirectPlay8Peer_GetPlayerContext(peer,ids[i],(void**)&context,0));record(context==0x1000+i);}
    marker("mesh-full.bin");record(wait_marker("mesh-go.bin"));if(!marked("mesh-go.bin")){failure=8;goto done;}
    if(role){
        payload[0]=0x4d;payload[1]=(BYTE)role;payload[2]=0x37;payload[3]=(BYTE)(role^0x5a);buffer.dwBufferSize=4;buffer.pBufferData=payload;
        hr=IDirectPlay8Peer_SendTo(peer,ids[3-role],&buffer,1,3000,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC);record(hr);if(FAILED(hr)){failure=9;goto done;}
        begin=GetTickCount();while(!received[3-role]&&GetTickCount()-begin<7000)Sleep(1);record(received[3-role]);if(!received[3-role]){failure=10;goto done;}
    }
    for(i=0;i<3;i++)if(i!=role){
        remote=0;hr=IDirectPlay8Peer_GetPeerAddress(peer,ids[i],&remote,0);record(hr);port=0;size=4;type=0;
        if(SUCCEEDED(hr)){record(IDirectPlay8Address_GetComponentByName(remote,L"port",&port,&size,&type));record(port);IDirectPlay8Address_Release(remote);remote=0;}
    }
    for(i=0;i<sizeof(app_storage);i++)app_storage[i]=0;((DPN_APPLICATION_DESC*)app_storage)->dwSize=sizeof(desc);size=sizeof(app_storage);
    record(IDirectPlay8Peer_GetApplicationDesc(peer,(DPN_APPLICATION_DESC*)app_storage,&size,0));record(((DPN_APPLICATION_DESC*)app_storage)->dwCurrentPlayers);record(invalid_receives);
    marker("mesh-metrics.bin");
    if(role==1){BYTE finish[4]={0x7e,1,3,0};DPN_BUFFER_DESC end;record(wait_marker("mesh-finish.bin"));end.pBufferData=finish;end.dwBufferSize=4;record(IDirectPlay8Peer_SendTo(peer,ids[2],&end,1,3000,0,0,DPNSEND_GUARANTEED|DPNSEND_SYNC));}
    record(wait_marker("mesh-close.bin"));if(!marked("mesh-close.bin")){failure=11;goto done;}
done:
    phase=2;
    if(peer){record(IDirectPlay8Peer_Close(peer,0));phase=3;callback_total=late_callbacks;Sleep(25);record(late_callbacks==callback_total);for(i=0;i<3;i++)record(destroys[i]);remove_hook();IDirectPlay8Peer_Release(peer);}
    if(device)IDirectPlay8Address_Release(device);if(host_address)IDirectPlay8Address_Release(host_address);if(remote)IDirectPlay8Address_Release(remote);
    flush_trace();record(failure);write_words("lan-oracle.bin",observations,observation_count);CoUninitialize();DeleteCriticalSection(&callback_lock);ExitProcess(failure?1:0);
}
