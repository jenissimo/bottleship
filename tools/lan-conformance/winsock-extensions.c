#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <mswsock.h>
#include <windows.h>
__declspec(dllexport) volatile DWORD oracle_results[256];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static const GUID accept_id = WSAID_ACCEPTEX, addresses_id = WSAID_GETACCEPTEXSOCKADDRS, connect_id = WSAID_CONNECTEX, disconnect_id = WSAID_DISCONNECTEX;
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output; oracle_results[0] = 0x42534c4e; oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static void extension(SOCKET socket, const GUID *id, void *target) {
    DWORD size = 0;
    int result = WSAIoctl(socket, SIO_GET_EXTENSION_FUNCTION_POINTER, (void *)id, sizeof(*id), target, sizeof(void *), &size, 0, 0);
    record(result); record(size);
    if (result != 0) finish();
}
void entry(void) {
    WSADATA data; SOCKET listener, target, client; struct sockaddr_in address, any; struct sockaddr *local, *remote;
    LPFN_ACCEPTEX accept_fn; LPFN_GETACCEPTEXSOCKADDRS addresses_fn; LPFN_CONNECTEX connect_fn; LPFN_DISCONNECTEX disconnect_fn;
    WSAOVERLAPPED accept_ov, connect_ov, disconnect_ov; DWORD bytes, flags; BOOL result; int size, local_size, remote_size;
    char output[68], data_bytes[4];
    oracle_results[2] = ORACLE_NONCE; record(WSAStartup(MAKEWORD(2,2), &data));
    listener = WSASocketA(AF_INET, SOCK_STREAM, IPPROTO_TCP, 0, 0, WSA_FLAG_OVERLAPPED);
    target = WSASocketA(AF_INET, SOCK_STREAM, IPPROTO_TCP, 0, 0, WSA_FLAG_OVERLAPPED);
    client = WSASocketA(AF_INET, SOCK_STREAM, IPPROTO_TCP, 0, 0, WSA_FLAG_OVERLAPPED);
    extension(listener, &accept_id, &accept_fn); extension(listener, &addresses_id, &addresses_fn);
    extension(client, &connect_id, &connect_fn); extension(client, &disconnect_id, &disconnect_fn);
    clear_bytes(&address, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(listener, (struct sockaddr *)&address, sizeof(address))); size = sizeof(address); getsockname(listener, (struct sockaddr *)&address, &size);
    record(listen(listener, 4));
    clear_bytes(&any, sizeof(any)); any.sin_family = AF_INET; record(bind(client, (struct sockaddr *)&any, sizeof(any)));
    clear_bytes(&accept_ov, sizeof(accept_ov)); clear_bytes(&connect_ov, sizeof(connect_ov)); clear_bytes(&disconnect_ov, sizeof(disconnect_ov));
    accept_ov.hEvent = WSACreateEvent(); connect_ov.hEvent = WSACreateEvent(); disconnect_ov.hEvent = WSACreateEvent(); clear_bytes(output, sizeof(output));
    result = accept_fn(listener, target, output, 4, 32, 32, &bytes, &accept_ov);
    record(result == FALSE); record(result ? 0 : WSAGetLastError());
    result = connect_fn(client, (struct sockaddr *)&address, sizeof(address), "abc", 3, &bytes, &connect_ov);
    record(result || WSAGetLastError() == WSA_IO_PENDING);
    if (WSAWaitForMultipleEvents(1, &connect_ov.hEvent, FALSE, 2000, FALSE) != 0) { record(-901); finish(); }
    record(WSAGetOverlappedResult(client, &connect_ov, &bytes, FALSE, &flags)); record(bytes); record(flags);
    record(setsockopt(client, SOL_SOCKET, SO_UPDATE_CONNECT_CONTEXT, 0, 0));
    if (WSAWaitForMultipleEvents(1, &accept_ov.hEvent, FALSE, 2000, FALSE) != 0) { record(-902); finish(); }
    record(WSAGetOverlappedResult(target, &accept_ov, &bytes, FALSE, &flags)); record(bytes); record(flags);
    record(output[0]); record(output[1]); record(output[2]);
    addresses_fn(output, 4, 32, 32, &local, &local_size, &remote, &remote_size);
    record(local_size); record(remote_size); record(local->sa_family); record(remote->sa_family);
    record((char *)local >= output + 4 && (char *)local + local_size <= output + 36);
    record((char *)remote >= output + 36 && (char *)remote + remote_size <= output + 68);
    size = sizeof(any); result = getsockname(target, (struct sockaddr *)&any, &size);
    record(result); record(result ? WSAGetLastError() : 0);
    record(setsockopt(target, SOL_SOCKET, SO_UPDATE_ACCEPT_CONTEXT, (const char *)&listener, sizeof(listener)));
    size = sizeof(any); record(getsockname(target, (struct sockaddr *)&any, &size)); record(any.sin_port == address.sin_port);
    record(send(target, "z", 1, 0)); record(recv(client, data_bytes, 1, 0)); record(data_bytes[0]);
    result = disconnect_fn(client, &disconnect_ov, TF_REUSE_SOCKET, 0);
    record(result || WSAGetLastError() == WSA_IO_PENDING);
    record(recv(target, data_bytes, sizeof(data_bytes), 0)); closesocket(target); target = INVALID_SOCKET;
    if (WSAWaitForMultipleEvents(1, &disconnect_ov.hEvent, FALSE, 2000, FALSE) != 0) { record(-903); finish(); }
    record(WSAGetOverlappedResult(client, &disconnect_ov, &bytes, FALSE, &flags)); record(bytes);
    clear_bytes(&any, sizeof(any)); any.sin_family = AF_INET; record(bind(client, (struct sockaddr *)&any, sizeof(any)));
    closesocket(client); closesocket(target); closesocket(listener);
    WSACloseEvent(accept_ov.hEvent); WSACloseEvent(connect_ov.hEvent); WSACloseEvent(disconnect_ov.hEvent);
    record(WSACleanup()); finish();
}
