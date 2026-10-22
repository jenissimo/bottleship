#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0600
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
__declspec(dllexport) volatile DWORD oracle_results[256];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void text(const char *s) { DWORD hash = 2166136261u, length = 0; while (*s) { hash = (hash ^ (BYTE)*s++) * 16777619u; length++; } record(length); record(hash); }
static void finish(void) {
    DWORD written; HANDLE output; oracle_results[0] = 0x42534c4e; oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
void entry(void) {
    WSADATA data; struct sockaddr_storage address; struct sockaddr_in *v4 = (struct sockaddr_in *)&address;
    struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&address; IN_ADDR ip4; IN6_ADDR ip6;
    char output[128]; WCHAR output_w[128]; DWORD size; int length, result, filter[2] = {IPPROTO_TCP, 0}; SOCKET socket_handle;
    static WSAPROTOCOL_INFOA protocols[16]; DWORD protocol_size = sizeof(protocols);
    oracle_results[2] = ORACLE_NONCE; record(WSAStartup(MAKEWORD(2,2), &data));
    record(sizeof(WSAPROTOCOL_INFOA)); record(sizeof(WSAPROTOCOL_INFOW));
    record(InetPtonA(AF_INET, "1.2.3.4", &ip4)); record(ip4.S_un.S_addr);
    record(InetPtonA(AF_INET, "01.2.3.4", &ip4));
    record(InetPtonA(AF_INET6, "2001:db8::1", &ip6));
    record(InetNtopA(AF_INET6, &ip6, output, sizeof(output)) != 0); text(output);
    record(InetPtonA(AF_INET6, "::ffff:192.0.2.1", &ip6));
    record(InetNtopA(AF_INET6, &ip6, output, sizeof(output)) != 0); text(output);
    clear_bytes(&address, sizeof(address)); length = sizeof(address);
    record(WSAStringToAddressA("1.2.3.4:1234", AF_INET, 0, (struct sockaddr *)&address, &length));
    record(length); record(v4->sin_port); record(v4->sin_addr.S_un.S_addr);
    size = sizeof(output); record(WSAAddressToStringA((struct sockaddr *)&address, length, 0, output, &size)); record(size); text(output);
    size = 1; result = WSAAddressToStringA((struct sockaddr *)&address, length, 0, output, &size); record(result); record(result ? WSAGetLastError() : 0); record(size);
    v4->sin_port = 0; size = sizeof(output); record(WSAAddressToStringA((struct sockaddr *)&address, length, 0, output, &size)); record(size); text(output);
    clear_bytes(&address, sizeof(address)); length = sizeof(address);
    record(WSAStringToAddressA("[fe80::1234%7]:1234", AF_INET6, 0, (struct sockaddr *)&address, &length));
    record(length); record(v6->sin6_port); record(v6->sin6_scope_id);
    size = sizeof(output); record(WSAAddressToStringA((struct sockaddr *)&address, length, 0, output, &size)); record(size); text(output);
    size = sizeof(output_w) / sizeof(WCHAR); record(WSAAddressToStringW((struct sockaddr *)&address, length, 0, output_w, &size)); record(size); record(output_w[0]);
    result = WSAEnumProtocolsA(filter, protocols, &protocol_size); record(result > 0); record(protocol_size % sizeof(WSAPROTOCOL_INFOA) == 0);
    socket_handle = WSASocketA(FROM_PROTOCOL_INFO, FROM_PROTOCOL_INFO, FROM_PROTOCOL_INFO, &protocols[0], 0, WSA_FLAG_OVERLAPPED);
    record(socket_handle != INVALID_SOCKET); if (socket_handle != INVALID_SOCKET) closesocket(socket_handle);
    record(WSACleanup()); finish();
}
