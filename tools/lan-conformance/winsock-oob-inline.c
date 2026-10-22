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
    WSADATA data; SOCKET listener, client, accepted; struct sockaddr_in address; int length, result; u_long available, mark;
    char bytes[64]; DWORD timeout = 100, received, receive_flags; WSABUF buffer; int on = 1; fd_set exceptional; struct timeval zero;
    oracle_results[2] = ORACLE_NONCE; record(WSAStartup(MAKEWORD(2,2), &data));
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); clear_bytes(&address,sizeof(address));
    address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind(listener,(struct sockaddr *)&address,sizeof(address)); length=sizeof(address); getsockname(listener,(struct sockaddr *)&address,&length); listen(listener,4);
    client=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP); connect(client,(struct sockaddr *)&address,sizeof(address)); accepted=accept(listener,0,0);
    setsockopt(accepted,SOL_SOCKET,SO_RCVTIMEO,(const char *)&timeout,sizeof(timeout));
    setsockopt(accepted,SOL_SOCKET,SO_OOBINLINE,(const char *)&on,sizeof(on));
    record(send(client,"abcd",4,0)); record(send(client,"u",1,MSG_OOB)); record(send(client,"efgh",4,0)); Sleep(100);
    FD_ZERO(&exceptional); FD_SET(accepted,&exceptional); zero.tv_sec=0; zero.tv_usec=0; record(select(0,0,0,&exceptional,&zero));
    available=99; record(ioctlsocket(accepted,FIONREAD,&available)); record(available);
    mark=99; record(ioctlsocket(accepted,SIOCATMARK,&mark)); record(mark);
    result=recv(accepted,bytes,sizeof(bytes),MSG_PEEK); record(result); record(result>0?bytes[0]:0); record(result>0?bytes[result-1]:0);
    buffer.buf=bytes; buffer.len=sizeof(bytes); received=receive_flags=0;
    result=WSARecv(accepted,&buffer,1,&received,&receive_flags,0,0); record(result); record(received); record(receive_flags); record(received?bytes[0]:0); record(received?bytes[received-1]:0);
    available=99; record(ioctlsocket(accepted,FIONREAD,&available)); record(available);
    mark=99; record(ioctlsocket(accepted,SIOCATMARK,&mark)); record(mark);
    result=recv(accepted,bytes,1,MSG_OOB); record(result); record(result>0?bytes[0]:WSAGetLastError());
    result=recv(accepted,bytes,sizeof(bytes),0); record(result); record(result>0?bytes[0]:WSAGetLastError()); record(result>0?bytes[result-1]:0);
    closesocket(client); closesocket(accepted); closesocket(listener); record(WSACleanup()); finish();
}
