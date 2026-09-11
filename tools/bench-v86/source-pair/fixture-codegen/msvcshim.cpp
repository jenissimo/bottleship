// PE arm only. Linking without the CRT still leaves the two references MSVC emits for any
// translation unit that touches doubles. Real games reach the same helper: NFSU's own CRT
// converts every float->int through __ftol2_sse, so keeping it as a call (rather than
// hand-avoiding the conversion) is what the game actually does.
#ifdef _MSC_VER
extern "C" int _fltused = 0x9875;

extern "C" __declspec(naked) void _ftol2_sse() {
    __asm {
        sub  esp, 12
        fnstcw word ptr [esp + 8]
        mov  ax, word ptr [esp + 8]
        or   ax, 0x0C00              // round toward zero, i.e. C truncation
        mov  word ptr [esp + 10], ax
        fldcw word ptr [esp + 10]
        fistp qword ptr [esp]
        fldcw word ptr [esp + 8]
        mov  eax, dword ptr [esp]
        mov  edx, dword ptr [esp + 4]
        add  esp, 12
        ret
    }
}
#endif
