#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count = 3, callback_error, callback_bytes, callback_thread, callbacks;
static void record(DWORD value) { oracle_results[count++] = value; }
static void zero(void *data, DWORD size) { unsigned char *p = data; while (size--) *p++ = 0; }
static void WINAPI completed(DWORD error, DWORD bytes, OVERLAPPED *ov) {
    (void)ov; callback_error = error; callback_bytes = bytes; callback_thread = GetCurrentThreadId(); callbacks++;
}
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
void entry(void) {
    HANDLE file, event; OVERLAPPED ov; DWORD written, tid = GetCurrentThreadId(); unsigned char buffer[8];
    file = CreateFileA("readfile-ex-data.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    record(file != INVALID_HANDLE_VALUE); record(WriteFile(file, "ABCD", 4, &written, 0)); CloseHandle(file);
    file = CreateFileA("readfile-ex-data.bin", GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, 0);
    record(file != INVALID_HANDLE_VALUE); record(SetFilePointer(file, 3, 0, FILE_BEGIN));
    event = CreateEventA(0, TRUE, FALSE, 0); zero(&ov, sizeof(ov)); ov.Offset = 1; ov.hEvent = event; zero(buffer, sizeof(buffer));
    record(ReadFileEx(file, buffer, 2, &ov, completed));
    record(SleepEx(2000, TRUE)); record(callbacks); record(callback_error); record(callback_bytes);
    record(callback_thread == tid); record(buffer[0]); record(buffer[1]); record(buffer[2]);
    record(ov.Internal); record(ov.InternalHigh); record(WaitForSingleObject(event, 0));
    record(SetFilePointer(file, 0, 0, FILE_CURRENT));
    zero(&ov, sizeof(ov)); ov.Offset = 64; zero(buffer, sizeof(buffer));
    record(ReadFileEx(file, buffer, 4, &ov, completed)); record(SleepEx(2000, TRUE));
    record(callbacks); record(callback_error); record(callback_bytes); record(buffer[0]); record(ov.Internal); record(ov.InternalHigh);
    CloseHandle(event); CloseHandle(file); DeleteFileA("readfile-ex-data.bin"); finish();
}
