/* Build as parent (PARENT=1), exiting parent (PARENT=2), and child (PARENT=0).
 * No CRT. The child appends A exactly once before claiming a window, then appends
 * its live variable B when Space is pressed. A re-exec leaves AAB instead of AB. */
#include <windows.h>
static char live_value;
static void append(char value) {
    DWORD written;
    HANDLE file = CreateFileA("C:\\once.dat", GENERIC_WRITE, FILE_SHARE_READ, 0, OPEN_ALWAYS, 0, 0);
    SetFilePointer(file, 0, 0, FILE_END);
    WriteFile(file, &value, 1, &written, 0);
    FlushFileBuffers(file);
    CloseHandle(file);
}
static LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_KEYDOWN && wp == VK_SPACE) { append(live_value); SetWindowTextA(hwnd, "Live child: AB"); return 0; }
    if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(hwnd, msg, wp, lp);
}
void entry(void) {
    // Exercise CRT-style FS access before the first WinAPI thunk can lazily repair it.
    unsigned teb;
    __asm__ volatile ("movl %%fs:0x18, %0" : "=r" (teb));
    if (!teb) ExitProcess(90);
#if PARENT
    static STARTUPINFOA si;
    static PROCESS_INFORMATION pi;
    si.cb = sizeof(si);
    DeleteFileA("C:\\once.dat");
#if PARENT == 3
    const char *child = "C:\\parent-exit.exe";
#else
    const char *child = "C:\\child.exe";
#endif
    if (!CreateProcessA(child, 0, 0, 0, FALSE, 0, 0, 0, &si, &pi)) ExitProcess(9);
#if PARENT == 1 || PARENT == 3
    WaitForSingleObject(pi.hProcess, INFINITE);
#endif
    ExitProcess(0);
#else
    static WNDCLASSA wc;
    static MSG msg;
    append('A');
    live_value = 'B';
    wc.lpfnWndProc = wndproc;
    wc.hInstance = GetModuleHandleA(0);
    wc.hCursor = LoadCursorA(0, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.lpszClassName = "LiveChildProbe";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowExA(0, wc.lpszClassName, "Live child: press Space", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        10, 10, 480, 320, 0, 0, wc.hInstance, 0);
    ShowWindow(hwnd, SW_SHOW);
    SetForegroundWindow(hwnd);
    while (GetMessageA(&msg, 0, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    ExitProcess(0);
#endif
}
