/* Native Windows oracle for the USER timer queue cancellation regression.
 * Build: gcc user32-timer-cancel-oracle.c -o timer-oracle.exe -luser32
 * Expected: 0, 1, 1, 0, 1, 1, 1, one value per line. */
#include <windows.h>
#include <stdio.h>

static LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    return DefWindowProcA(hwnd, msg, wp, lp);
}
static void flush(void) {
    MSG msg;
    while (PeekMessageA(&msg, NULL, WM_TIMER, WM_TIMER, PM_REMOVE)) {}
}
int main(void) {
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = wndproc;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "BottleShipTimerCancelOracle";
    if (!RegisterClassA(&wc)) return 1;
    HWND hwnd = CreateWindowA(wc.lpszClassName, "", 0, 0, 0, 1, 1, NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) return 2;
    MSG msg;

    SetTimer(hwnd, 123, 10, NULL); Sleep(80); KillTimer(hwnd, 123);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE)); flush();

    SetTimer(hwnd, 123, 10, NULL); Sleep(80);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_NOREMOVE));
    KillTimer(hwnd, 123);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE)); flush();

    SetTimer(hwnd, 123, 10, NULL); Sleep(80); SetTimer(hwnd, 123, 1000, NULL);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE));
    KillTimer(hwnd, 123); flush();

    PostMessageA(hwnd, WM_TIMER, 123, 0); KillTimer(hwnd, 123);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE)); flush();

    SetTimer(hwnd, 123, 10, NULL); Sleep(80);
    PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_NOREMOVE);
    SetTimer(hwnd, 123, 10, NULL); Sleep(80);
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE));
    printf("%d\n", !!PeekMessageA(&msg, hwnd, WM_TIMER, WM_TIMER, PM_REMOVE));
    KillTimer(hwnd, 123); flush(); DestroyWindow(hwnd);
    return 0;
}
