#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "pair.h"

extern "C" void pair_service(uint32_t mode) {
    if (mode == 1) (void)GetTickCount();
    else if (mode == 2) (void)GetFileAttributesA("C:\\pair-service.bin");
    else if (mode == 3) Sleep(1);
}

static uint32_t next_number(const char*& text) {
    while (*text == ' ') ++text;
    uint32_t n = 0;
    while (*text >= '0' && *text <= '9') n = n * 10u + uint32_t(*text++ - '0');
    return n;
}
static bool write_file(const char* name, const void* data, uint32_t length) {
    HANDLE f = CreateFileA(name, GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (f == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    BOOL ok = WriteFile(f, data, length, &written, 0);
    CloseHandle(f);
    return ok && written == length;
}
static void path_for(char* out, uint32_t token, const char* suffix) {
    const char* prefix = "C:\\pair-";
    while (*prefix) *out++ = *prefix++;
    char digits[10]; uint32_t n = 0;
    do { digits[n++] = char('0' + token % 10); token /= 10; } while (token);
    while (n) *out++ = digits[--n];
    while (*suffix) *out++ = *suffix++;
    *out = 0;
}

extern "C" void mainCRTStartup() {
    const char* cmd = GetCommandLineA();
    if (*cmd == '"') { ++cmd; while (*cmd && *cmd != '"') ++cmd; if (*cmd) ++cmd; }
    else while (*cmd && *cmd != ' ') ++cmd;
    const uint32_t seed = next_number(cmd), operations = next_number(cmd);
    const uint32_t burst = next_number(cmd), mode = next_number(cmd), variable = next_number(cmd);
    const uint32_t controlled = next_number(cmd);
    const uint32_t token = next_number(cmd);
    char ready[64], go[64], result[64];
    path_for(ready, token, "-ready.bin"); path_for(go, token, "-go.bin"); path_for(result, token, "-result.bin");
    if (!operations || !burst || mode > 3 || variable > 1) ExitProcess(2);
    uint32_t round = 0;
    for (;;) {
    if (controlled == 2) {
        path_for(ready, token + round, "-ready.bin");
        path_for(go, token + round, "-go.bin");
        path_for(result, token + round, "-result.bin");
    }
    pair_init(seed);
    if (controlled) {
        if (!write_file(ready, &pair_data, sizeof(pair_data))) ExitProcess(3);
        while (GetFileAttributesA(go) == INVALID_FILE_ATTRIBUTES) Sleep(10);
    }
    OutputDebugStringA("SOURCE_PAIR_BEGIN");
    pair_run(operations, burst, mode, variable);
    OutputDebugStringA("SOURCE_PAIR_END");
    if (!write_file(controlled ? result : "pair-result.bin", &pair_data, sizeof(pair_data))) ExitProcess(4);
    if (controlled == 2) { ++round; continue; }
    if (controlled) { for (;;) Sleep(1000); }
    ExitProcess(0);
    }
}
