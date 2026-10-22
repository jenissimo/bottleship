#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

/* Run the same PE on Windows and BottleShip; record API observations, not expectations. */
__declspec(dllexport) volatile DWORD oracle_results[128];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static SOCKET apc_tx;
static struct sockaddr_in apc_address;
static WSAOVERLAPPED apc_overlapped;
static volatile DWORD apc_count, apc_error, apc_bytes, apc_flags, apc_same_overlapped, apc_same_thread;
static DWORD apc_owner;
static void CALLBACK receive_complete(DWORD error, DWORD bytes, LPWSAOVERLAPPED overlapped, DWORD flags) {
    apc_error = error; apc_bytes = bytes; apc_flags = flags;
    apc_same_overlapped = overlapped == &apc_overlapped;
    apc_same_thread = GetCurrentThreadId() == apc_owner;
    apc_count++;
}
static DWORD WINAPI delayed_send(LPVOID ignored) {
    (void)ignored;
    Sleep(50);
    sendto(apc_tx, "apc", 3, 0, (struct sockaddr *)&apc_address, sizeof(apc_address));
    return 0;
}
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) {
    unsigned char *p = (unsigned char *)value;
    while (size--) *p++ = 0;
}
static void finish(void) {
    DWORD written;
    HANDLE output;
    oracle_results[0] = 0x42534c4e;
    oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * sizeof(DWORD), &written, 0);
        CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}

void entry(void) {
    WSADATA data; SOCKET s; int family,protocol,level,value,length,r;
    struct sockaddr_storage address;
    oracle_results[2]=ORACLE_NONCE; record(WSAStartup(MAKEWORD(2,2),&data));
    for(family=AF_INET;family<=AF_INET6;family+=AF_INET6-AF_INET) {
        protocol=family==AF_INET?1:58; level=family==AF_INET?IPPROTO_IP:IPPROTO_IPV6;
        s=WSASocketA(family,SOCK_RAW,protocol,0,0,WSA_FLAG_OVERLAPPED); record(s!=INVALID_SOCKET);
        if(s==INVALID_SOCKET){record(WSAGetLastError());continue;}
        value=177;length=4;r=getsockopt(s,level,2,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
        value=1;r=setsockopt(s,level,2,(char*)&value,4);record(r);record(r?WSAGetLastError():0);
        length=4;value=177;r=getsockopt(s,level,2,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
        value=0;r=setsockopt(s,level,2,(char*)&value,4);record(r);record(r?WSAGetLastError():0);
        value=177;length=4;r=getsockopt(s,level,4,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
        value=17;r=setsockopt(s,level,4,(char*)&value,4);record(r);record(r?WSAGetLastError():0);
        value=177;length=4;r=getsockopt(s,level,4,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
        value=0;r=setsockopt(s,level,4,(char*)&value,4);record(r);record(r?WSAGetLastError():0);
        clear_bytes(&address,sizeof(address));address.ss_family=family;
        ((unsigned char*)&address)[2]=0x04;((unsigned char*)&address)[3]=0xd2;
        if(family==AF_INET){((unsigned char*)&address)[4]=127;((unsigned char*)&address)[7]=1;}
        else ((unsigned char*)&address)[23]=1;
        r=bind(s,(struct sockaddr*)&address,family==AF_INET?16:28);record(r);record(r?WSAGetLastError():0);
        length=sizeof(address);r=getsockname(s,(struct sockaddr*)&address,&length);
        record(r);record(r?WSAGetLastError():0);record(length);record(r?0:((unsigned char*)&address)[2]*256+((unsigned char*)&address)[3]);
        if(family==AF_INET6) {
            value=177;length=4;r=getsockopt(s,level,26,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
            value=2;r=setsockopt(s,level,26,(char*)&value,4);record(r);record(r?WSAGetLastError():0);
            value=177;length=4;r=getsockopt(s,level,26,(char*)&value,&length);record(r);record(r?WSAGetLastError():value);
        }
        closesocket(s);
    }
    record(WSACleanup());finish();
}
