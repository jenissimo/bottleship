#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#ifdef ORACLE_VERIFY_IDENTITY
#define ORACLE_CHILD_WORDS 6
#else
#define ORACLE_CHILD_WORDS 4
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count = 3;
static void record(int value) { oracle_results[count++] = value; }
static void clear_bytes(void *value, DWORD size) { unsigned char *p = value; while (size--) *p++ = 0; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
static int child_port(void) {
    char *line = GetCommandLineA(); int i, port;
    for (i = 0; line[i]; i++) if (line[i] == '-' && line[i+1] == '-' &&
        line[i+2] == 'c' && line[i+3] == 'h' && line[i+4] == 'i' && line[i+5] == 'l' && line[i+6] == 'd' && line[i+7] == ' ') {
        i += 8; port = 0; while (line[i] >= '0' && line[i] <= '9') port = port * 10 + line[i++] - '0';
        return port;
    }
    return 0;
}
static void run_child(int port) {
    SOCKET probe, client; struct sockaddr_in address; int observations[ORACLE_CHILD_WORDS], amount, total; char reply[3];
    clear_bytes(&address, sizeof(address)); address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons((u_short)port);
    probe = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    observations[0] = bind(probe, (struct sockaddr *)&address, sizeof(address));
    observations[1] = observations[0] == SOCKET_ERROR ? WSAGetLastError() : 0;
    closesocket(probe);
    client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    observations[2] = connect(client, (struct sockaddr *)&address, sizeof(address));
    observations[3] = observations[2] == SOCKET_ERROR ? WSAGetLastError() : 0;
    if (observations[2]) ExitProcess(11);
#ifdef ORACLE_VERIFY_IDENTITY
    observations[4] = GetCurrentProcessId();
    __asm__ volatile ("movl %%fs:0x20,%0" : "=r" (observations[5]));
#endif
    total = 0;
    while (total < sizeof(observations)) {
        amount = send(client, (char *)observations + total, sizeof(observations) - total, 0);
        if (amount <= 0) ExitProcess(12); total += amount;
    }
    total = 0;
    while (total < 3) { amount = recv(client, reply + total, 3 - total, 0); if (amount <= 0) ExitProcess(13); total += amount; }
    closesocket(client);
    ExitProcess(reply[0] == 'a' && reply[1] == 'c' && reply[2] == 'k' ? 17 : 14);
}
void entry(void) {
    WSADATA data;
    SOCKET listener, accepted;
    struct sockaddr_in address;
    int size, port, i, length, digit_count, amount, total, observations[ORACLE_CHILD_WORDS];
    char command[1024], path[512], digits[8];
    STARTUPINFOA startup;
    PROCESS_INFORMATION child;
    DWORD code;
    WSAStartup(MAKEWORD(2, 2), &data);
    port = child_port(); if (port) run_child(port);
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    clear_bytes(&address, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    record(bind(listener, (struct sockaddr *)&address, sizeof(address)));
    size = sizeof(address); record(getsockname(listener, (struct sockaddr *)&address, &size));
    record(listen(listener, 4));
    port = ntohs(address.sin_port);
    length = GetModuleFileNameA(0, path, sizeof(path));
    command[0] = '"'; for (i = 0; i < length; i++) command[i + 1] = path[i];
    length++; command[length++] = '"'; command[length++] = ' ';
    command[length++] = '-'; command[length++] = '-'; command[length++] = 'c';
    command[length++] = 'h'; command[length++] = 'i'; command[length++] = 'l'; command[length++] = 'd'; command[length++] = ' ';
    digit_count = 0; do { digits[digit_count++] = '0' + port % 10; port /= 10; } while (port);
    while (digit_count) command[length++] = digits[--digit_count]; command[length] = 0;
    clear_bytes(&startup, sizeof(startup)); startup.cb = sizeof(startup); clear_bytes(&child, sizeof(child));
    i = CreateProcessA(0, command, 0, 0, FALSE, CREATE_NO_WINDOW, 0, 0, &startup, &child);
    record(i); if (!i) finish();
    accepted = accept(listener, 0, 0); record(accepted == INVALID_SOCKET ? -1 : 0);
    if (accepted == INVALID_SOCKET) finish();
    total = 0;
    while (total < sizeof(observations)) {
        amount = recv(accepted, (char *)observations + total, sizeof(observations) - total, 0);
        if (amount <= 0) break; total += amount;
    }
    record(total);
    if (total == sizeof(observations)) for (i = 0; i < 4; i++) record(observations[i]);
#ifdef ORACLE_VERIFY_IDENTITY
    record((DWORD)observations[4] == child.dwProcessId);
    record((DWORD)observations[4] != GetCurrentProcessId());
    record(observations[4] == observations[5]);
    record(GetProcessId(child.hProcess) == child.dwProcessId);
#endif
#ifdef ORACLE_KILL_CHILD
    record(TerminateProcess(child.hProcess, 19));
#else
    record(send(accepted, "ack", 3, 0));
#endif
    record(WaitForSingleObject(child.hProcess, 10000));
    record(GetExitCodeProcess(child.hProcess, &code)); record(code);
    record(recv(accepted, command, sizeof(command), 0));
    CloseHandle(child.hProcess); CloseHandle(child.hThread); closesocket(accepted); closesocket(listener);
    record(WSACleanup()); finish();
}
