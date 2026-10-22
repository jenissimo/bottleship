#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count = 3;
static void record(DWORD value) { oracle_results[count++] = value; }
static void finish(void) {
    DWORD written; HANDLE output;
    oracle_results[0] = 0x42534c4e; oracle_results[1] = count; oracle_results[2] = ORACLE_NONCE;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) { WriteFile(output, (const void *)oracle_results, count * 4, &written, 0); CloseHandle(output); }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}
struct waiter { HANDLE input, ready, done; DWORD result; };
static DWORD WINAPI wait_thread(void *data) {
    struct waiter *w = data;
    SetEvent(w->ready); w->result = WaitForSingleObject(w->input, 3000); SetEvent(w->done); return 0;
}
void entry(void) {
    HANDLE event, alias, third, process = GetCurrentProcess(), threads[2];
    struct waiter waiters[2]; int i;
    event = CreateEventA(0, TRUE, FALSE, 0); alias = 0;
    record(event != 0); record(DuplicateHandle(process, event, process, &alias, 0, FALSE, DUPLICATE_SAME_ACCESS));
    record(alias != event);
    record(SetEvent(alias)); record(WaitForSingleObject(event, 0)); record(WaitForSingleObject(alias, 0));
    record(ResetEvent(event)); record(WaitForSingleObject(alias, 0));
    record(SetEvent(event)); record(CloseHandle(event)); record(WaitForSingleObject(alias, 0));
    third = 0; record(DuplicateHandle(process, alias, process, &third, 0, FALSE, DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE));
    record(WaitForSingleObject(third, 0)); record(third == alias || WaitForSingleObject(alias, 0) == WAIT_FAILED); CloseHandle(third);
    event = CreateEventA(0, FALSE, TRUE, 0); alias = 0;
    record(DuplicateHandle(process, event, process, &alias, 0, FALSE, DUPLICATE_SAME_ACCESS));
    record(WaitForSingleObject(alias, 0)); record(WaitForSingleObject(event, 0));
    record(SetEvent(event)); record(WaitForSingleObject(alias, 0)); record(WaitForSingleObject(event, 0));
    record(SetEvent(alias)); record(WaitForSingleObject(event, 0)); record(WaitForSingleObject(alias, 0));
    CloseHandle(event); CloseHandle(alias);
    event = CreateEventA(0, TRUE, FALSE, 0);
    DuplicateHandle(process, event, process, &alias, 0, FALSE, DUPLICATE_SAME_ACCESS);
    for (i = 0; i < 2; i++) {
        waiters[i].input = i ? alias : event;
        waiters[i].ready = CreateEventA(0, TRUE, FALSE, 0);
        waiters[i].done = CreateEventA(0, TRUE, FALSE, 0); waiters[i].result = 0xdead;
        threads[i] = CreateThread(0, 0, wait_thread, &waiters[i], 0, 0);
        record(threads[i] != 0); record(WaitForSingleObject(waiters[i].ready, 3000));
    }
    Sleep(20); record(SetEvent(alias));
    for (i = 0; i < 2; i++) {
        record(WaitForSingleObject(waiters[i].done, 4000)); record(waiters[i].result);
        record(WaitForSingleObject(threads[i], 1000));
        CloseHandle(threads[i]); CloseHandle(waiters[i].ready); CloseHandle(waiters[i].done);
    }
    CloseHandle(event); record(ResetEvent(alias)); record(WaitForSingleObject(alias, 0)); CloseHandle(alias);
    finish();
}
