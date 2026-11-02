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
    WSADATA data;
    SOCKET rx, tx, listener, client, accepted;
    struct sockaddr_in address, source;
    int size, result;
    u_long on = 1;
    char bytes[8];
    WSAEVENT event;
    WSANETWORKEVENTS events;

    oracle_results[2] = ORACLE_NONCE;
    record(WSAStartup(MAKEWORD(2, 2), &data));
    WSASetLastError(12345);
    rx = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    record(WSAGetLastError());
    if (rx == INVALID_SOCKET) finish();
    tx = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    clear_bytes(&address, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(rx, (struct sockaddr *)&address, sizeof(address)));
    size = sizeof(address);
    record(getsockname(rx, (struct sockaddr *)&address, &size));
    record(size);

    record(sendto(tx, "", 0, 0, (struct sockaddr *)&address, sizeof(address)));
    {
        fd_set readable;
        struct timeval timeout;
        FD_ZERO(&readable);
        FD_SET(rx, &readable);
        timeout.tv_sec = 1;
        timeout.tv_usec = 0;
        record(select(0, &readable, 0, 0, &timeout));
    }
    size = sizeof(source);
    record(recvfrom(rx, bytes, sizeof(bytes), 0, (struct sockaddr *)&source, &size));
    record(sendto(tx, "abc", 3, 0, (struct sockaddr *)&address, sizeof(address)));
    size = sizeof(source);
    result = recvfrom(rx, bytes, 1, 0, (struct sockaddr *)&source, &size);
    record(result);
    record(result == SOCKET_ERROR ? WSAGetLastError() : 0);
    record(bytes[0]);
    record(ioctlsocket(rx, FIONBIO, &on));
    result = recv(rx, bytes, sizeof(bytes), 0);
    record(result);
    record(result == SOCKET_ERROR ? WSAGetLastError() : 0);

    event = WSACreateEvent();
    record(WSAEventSelect(tx, event, FD_WRITE));
    record(WSAWaitForMultipleEvents(1, &event, FALSE, 1000, FALSE));
    clear_bytes(&events, sizeof(events));
    record(WSAEnumNetworkEvents(tx, event, &events));
    record(events.lNetworkEvents);
    record(events.iErrorCode[FD_WRITE_BIT]);
    WSACloseEvent(event);
    closesocket(tx);
    closesocket(rx);

    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    address.sin_port = 0;
    record(bind(listener, (struct sockaddr *)&address, sizeof(address)));
    size = sizeof(address);
    getsockname(listener, (struct sockaddr *)&address, &size);
    record(listen(listener, 4));
    client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    record(connect(client, (struct sockaddr *)&address, sizeof(address)));
    accepted = accept(listener, 0, 0);
    record(accepted == INVALID_SOCKET ? SOCKET_ERROR : 0);
    if (accepted == INVALID_SOCKET) finish();
    record(send(client, "abcd", 4, 0));
    record(recv(accepted, bytes, 2, MSG_PEEK));
    record(bytes[0]);
    record(recv(accepted, bytes, 3, 0));
    record(bytes[2]);
    record(recv(accepted, bytes, 1, 0));
    record(bytes[0]);
    record(shutdown(client, SD_SEND));
    record(recv(accepted, bytes, sizeof(bytes), 0));
    closesocket(client);
    closesocket(accepted);
    closesocket(listener);
    /* Complete after the issuing thread has entered an alertable wait. */
    rx = WSASocketA(AF_INET, SOCK_DGRAM, IPPROTO_UDP, 0, 0, WSA_FLAG_OVERLAPPED);
    apc_tx = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    clear_bytes(&apc_address, sizeof(apc_address));
    clear_bytes(&apc_overlapped, sizeof(apc_overlapped));
    apc_address.sin_family = AF_INET;
    apc_address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(rx, (struct sockaddr *)&apc_address, sizeof(apc_address)));
    size = sizeof(apc_address);
    getsockname(rx, (struct sockaddr *)&apc_address, &size);
    {
        WSABUF buffer;
        DWORD bytes_received = 0, flags = 0;
        HANDLE sender;
        buffer.buf = bytes; buffer.len = sizeof(bytes);
        apc_owner = GetCurrentThreadId();
        result = WSARecv(rx, &buffer, 1, &bytes_received, &flags, &apc_overlapped, receive_complete);
        record(result);
        record(result == SOCKET_ERROR ? WSAGetLastError() : 0);
        sender = CreateThread(0, 0, delayed_send, 0, 0, 0);
        record(sender ? 1 : 0);
        record(SleepEx(2000, TRUE));
        record(apc_count);
        record(apc_error);
        record(apc_bytes);
        record(apc_flags);
        record(apc_same_overlapped);
        record(apc_same_thread);
        record(bytes[0]);
        record(WSAGetOverlappedResult(rx, &apc_overlapped, &bytes_received, FALSE, &flags));
        record(bytes_received);
        record(flags);
        WaitForSingleObject(sender, 2000);
        CloseHandle(sender);
    }
    closesocket(apc_tx);
    closesocket(rx);
    result = closesocket((SOCKET)0xffffffff);
    record(result);
    record(result == SOCKET_ERROR ? WSAGetLastError() : 0);
    record(WSACleanup());
    finish();
}
