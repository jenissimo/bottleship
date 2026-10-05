#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "codegen.h"

// PE arm host. No CRT: argument parsing and the result write are done by hand so the only
// code the JIT sees for a kernel is the kernel itself.

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

extern "C" void mainCRTStartup() {
    const char* cmd = GetCommandLineA();
    if (*cmd == '"') { ++cmd; while (*cmd && *cmd != '"') ++cmd; if (*cmd) ++cmd; }
    else while (*cmd && *cmd != ' ') ++cmd;
    const uint32_t seed = next_number(cmd);
    const uint32_t kernel = next_number(cmd);
    const uint32_t count = next_number(cmd);
    const uint32_t rounds = next_number(cmd);
    const uint32_t controlled = next_number(cmd);
    if (!seed || kernel < 1 || kernel > 6 || !count || !rounds) ExitProcess(2);

    cg_init(seed);
    // The capture has to be armed BEFORE the kernel's page is compiled. Without a gate the
    // guest would already be hot by the time the driver's load call returns, and the run would
    // capture nothing while looking like it worked.
    if (controlled) {
        while (!cg_go) Sleep(10);
    }
    // Markers bracket ONLY the measured work: a window that also contains startup or the
    // result write is a window about the host, not about the kernel. The elapsed time is
    // reported through the same channel, because fixed work timed by the GUEST is what an
    // engine A/B needs — a host-side window would also contain load and teardown.
    OutputDebugStringA("CODEGEN_PAIR_BEGIN");
    const DWORD t0 = GetTickCount();
    cg_run(kernel, count, rounds);
    const DWORD elapsed = GetTickCount() - t0;
    char line[64];
    char* w = line;
    for (const char* p = "CODEGEN_PAIR_MS="; *p; ++p) *w++ = *p;
    char digits[12]; uint32_t n = 0, v = elapsed;
    do { digits[n++] = char('0' + v % 10u); v /= 10u; } while (v);
    while (n) *w++ = digits[--n];
    *w = 0;
    OutputDebugStringA(line);
    // The state checksum is the correctness half: a timing arm that quietly did different work
    // is not a faster arm, and this is what the Emscripten arm is compared against.
    w = line;
    for (const char* p = "CODEGEN_PAIR_SUM="; *p; ++p) *w++ = *p;
    uint32_t sum = cg_checksum();
    n = 0;
    do { digits[n++] = char('0' + sum % 10u); sum /= 10u; } while (sum);
    while (n) *w++ = digits[--n];
    *w = 0;
    OutputDebugStringA(line);
    OutputDebugStringA("CODEGEN_PAIR_END");

    if (!write_file("C:\\codegen-result.bin", &cg_data, sizeof(cg_data))) ExitProcess(3);
    ExitProcess(0);
}
