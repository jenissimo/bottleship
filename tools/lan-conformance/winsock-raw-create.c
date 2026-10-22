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
    WSADATA data; SOCKET socket; int families[6]={AF_INET,AF_INET,AF_INET,AF_INET,AF_INET6,AF_INET6};
    int protocols[6]={0,1,6,255,0,58},i,value,length,result; struct sockaddr_storage address;
    oracle_results[2]=ORACLE_NONCE; record(WSAStartup(MAKEWORD(2,2),&data));
    for(i=0;i<6;i++) {
        WSASetLastError(177); socket=WSASocketA(families[i],SOCK_RAW,protocols[i],0,0,WSA_FLAG_OVERLAPPED);
        record(socket!=INVALID_SOCKET); record(WSAGetLastError());
        if(socket==INVALID_SOCKET) continue;
        length=sizeof(address); clear_bytes(&address,sizeof(address)); result=getsockname(socket,(struct sockaddr *)&address,&length);
        record(result); record(result?WSAGetLastError():0); record(result?0:address.ss_family);
        value=177; length=sizeof(value); result=getsockopt(socket,families[i]==AF_INET?IPPROTO_IP:IPPROTO_IPV6,2,(char *)&value,&length);
        record(result); record(result?WSAGetLastError():value);
        closesocket(socket);
    }
    record(WSACleanup()); finish();
}
