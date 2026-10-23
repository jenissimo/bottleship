#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
static HANDLE WINAPI initiallyFalseEvent(LPSECURITY_ATTRIBUTES,BOOL,BOOL,LPCSTR);
#define CreateEventA initiallyFalseEvent
#include "ip-topology-control-apc.c"
#undef CreateEventA
static HANDLE WINAPI initiallyFalseEvent(LPSECURITY_ATTRIBUTES attributes,BOOL manual,BOOL initial,LPCSTR name){(void)initial;return CreateEventA(attributes,manual,FALSE,name);}
