#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
__declspec(dllexport) volatile DWORD oracle_results[256];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static SOCKET sender_socket;
static DWORD caller_count, condition_result, caller_valid, callee_valid, caller_data_kind, callee_data_kind, qos_kind, context_valid;
static unsigned short listener_port;
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * sizeof(DWORD), &written, 0);
        CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static int CALLBACK condition(LPWSABUF caller, LPWSABUF caller_data, LPQOS sqos, LPQOS gqos,
    LPWSABUF callee, LPWSABUF callee_data, GROUP *group, DWORD_PTR context) {
    caller_count++;
    caller_valid = caller && caller->len == sizeof(struct sockaddr_in) &&
        ((struct sockaddr_in *)caller->buf)->sin_family == AF_INET &&
        ((struct sockaddr_in *)caller->buf)->sin_port != 0;
    callee_valid = callee && callee->len == sizeof(struct sockaddr_in) &&
        ((struct sockaddr_in *)callee->buf)->sin_family == AF_INET &&
        ((struct sockaddr_in *)callee->buf)->sin_port == listener_port;
    caller_data_kind = caller_data ? (caller_data->len == 0 && caller_data->buf == 0 ? 1 : 2) : 0;
    callee_data_kind = callee_data ? (callee_data->len == 0 && callee_data->buf == 0 ? 1 : 2) : 0;
    qos_kind = (sqos != 0) | ((gqos != 0) << 1);
    context_valid = context == 0x12345678;
    if (group) *group = 0;
    return condition_result;
}
static SOCKET make_listener(struct sockaddr_in *address) {
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); int length = sizeof(*address);
    clear_bytes(address, sizeof(*address)); address->sin_family = AF_INET; address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (listener == INVALID_SOCKET || bind(listener, (struct sockaddr *)address, sizeof(*address)) != 0 ||
        getsockname(listener, (struct sockaddr *)address, &length) != 0 || listen(listener, 4) != 0) { record(-900); finish(); }
    return listener;
}
static void pair(SOCKET *client, SOCKET *server) {
    struct sockaddr_in address; SOCKET listener = make_listener(&address);
    *client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (connect(*client, (struct sockaddr *)&address, sizeof(address)) != 0) { record(-901); finish(); }
    *server = accept(listener, 0, 0); closesocket(listener);
    if (*server == INVALID_SOCKET) { record(-902); finish(); }
}
static DWORD WINAPI delayed_parts(LPVOID mode) {
    Sleep(50); send(sender_socket, "ab", mode ? 1 : 2, 0);
    if (!mode) { Sleep(50); send(sender_socket, "cd", 2, 0); }
    else shutdown(sender_socket, SD_SEND);
    return 0;
}
void entry(void) {
    WSADATA data; struct sockaddr_in address; SOCKET listener, client, accepted; int result, length;
    DWORD timeout = 1500; char bytes[8]; u_long mark; fd_set except; struct timeval wait; HANDLE thread;
    oracle_results[2] = ORACLE_NONCE; record(WSAStartup(MAKEWORD(2, 2), &data));
    listener = make_listener(&address); listener_port = address.sin_port;
    client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    record(connect(client, (struct sockaddr *)&address, sizeof(address)));
    condition_result = CF_DEFER; length = sizeof(address);
    accepted = WSAAccept(listener, (struct sockaddr *)&address, &length, condition, 0x12345678);
    record(accepted == INVALID_SOCKET ? -1 : 0); record(accepted == INVALID_SOCKET ? WSAGetLastError() : 0);
    record(caller_count); record(caller_valid); record(callee_valid); record(caller_data_kind); record(callee_data_kind); record(qos_kind); record(context_valid);
    condition_result = CF_ACCEPT;
    accepted = WSAAccept(listener, 0, 0, condition, 0x12345678);
    record(accepted == INVALID_SOCKET ? -1 : 0); record(caller_count);
    if (accepted != INVALID_SOCKET) {
        record(send(client, "k", 1, 0)); record(recv(accepted, bytes, 1, 0)); record(bytes[0]); closesocket(accepted);
    }
    closesocket(client); closesocket(listener);
    listener = make_listener(&address); listener_port = address.sin_port; client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    record(connect(client, (struct sockaddr *)&address, sizeof(address)));
    condition_result = CF_REJECT; accepted = WSAAccept(listener, 0, 0, condition, 0x12345678);
    record(accepted == INVALID_SOCKET ? -1 : 0); record(accepted == INVALID_SOCKET ? WSAGetLastError() : 0);
    closesocket(client); closesocket(listener);
    pair(&client, &accepted); setsockopt(accepted, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
    record(send(client, "xy", 2, MSG_OOB));
    FD_ZERO(&except); FD_SET(accepted, &except); wait.tv_sec = 1; wait.tv_usec = 0;
    record(select(0, 0, 0, &except, &wait));
    mark = 99; record(ioctlsocket(accepted, SIOCATMARK, &mark)); record(mark);
    record(recv(accepted, bytes, 1, 0)); record(bytes[0]);
    mark = 99; record(ioctlsocket(accepted, SIOCATMARK, &mark)); record(mark);
    record(recv(accepted, bytes, 1, MSG_OOB)); record(bytes[0]);
    FD_ZERO(&except); FD_SET(accepted, &except); wait.tv_sec = 0; wait.tv_usec = 0;
    record(select(0, 0, 0, &except, &wait));
    record(send(client, "z", 1, 0)); record(recv(accepted, bytes, 1, 0)); record(bytes[0]);
    mark = 99; record(ioctlsocket(accepted, SIOCATMARK, &mark)); record(mark);
    closesocket(client); closesocket(accepted);
    pair(&client, &accepted); sender_socket = client; clear_bytes(bytes, sizeof(bytes));
    thread = CreateThread(0, 0, delayed_parts, 0, 0, 0);
    record(recv(accepted, bytes, 4, MSG_WAITALL)); record(bytes[0]); record(bytes[1]); record(bytes[2]); record(bytes[3]);
    WaitForSingleObject(thread, 2000); CloseHandle(thread);
    thread = CreateThread(0, 0, delayed_parts, (LPVOID)1, 0, 0);
    record(recv(accepted, bytes, 4, MSG_WAITALL)); record(bytes[0]);
    WaitForSingleObject(thread, 2000); CloseHandle(thread);
    closesocket(client); closesocket(accepted); record(WSACleanup()); finish();
}
