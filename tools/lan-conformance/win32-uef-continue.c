#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[256];
static DWORD count=3,mode,fault_count,code,access_type,address_match,context_valid,context_flags;
static BYTE *page;
volatile DWORD resume_eip,resume_esp,resume_ebp,observed_flags,observed_eax;
static void record(DWORD value){oracle_results[count++]=value;}
static DWORD WINAPI watchdog(void *unused){(void)unused;Sleep(7000);ExitProcess(98);return 0;}
static LONG WINAPI filter(EXCEPTION_POINTERS *info){
 DWORD old;fault_count++;code=info->ExceptionRecord->ExceptionCode;
 access_type=info->ExceptionRecord->NumberParameters>=2?info->ExceptionRecord->ExceptionInformation[0]:0xfeed;
 address_match=info->ExceptionRecord->NumberParameters>=2&&info->ExceptionRecord->ExceptionInformation[1]==(ULONG_PTR)(mode==2?(BYTE*)1:page);
 context_valid=info->ContextRecord->Eip!=0&&info->ContextRecord->Esp!=0;
 context_flags=info->ContextRecord->ContextFlags&CONTEXT_FULL;
 if(fault_count!=1)ExitProcess(97);
 if(mode==0){if(!VirtualProtect(page,4096,PAGE_READWRITE,&old))ExitProcess(96);return EXCEPTION_CONTINUE_EXECUTION;}
 info->ContextRecord->Eip=resume_eip;info->ContextRecord->Esp=resume_esp;info->ContextRecord->Ebp=resume_ebp;
 info->ContextRecord->Eax=0x12345678;
 info->ContextRecord->EFlags=(info->ContextRecord->EFlags&~0x8c5)|0x845;
 return EXCEPTION_CONTINUE_EXECUTION;
}
void __cdecl probe(HANDLE handle,DWORD *output,DWORD hardware);
__asm__(
".text\n.globl _probe\n_probe:\n"
"pushl %ebp\nmovl %esp,%ebp\npushl %ebx\npushl %esi\npushl %edi\n"
"movl %esp,_resume_esp\nmovl %ebp,_resume_ebp\nmovl $1f,_resume_eip\n"
"cmpl $0,16(%ebp)\njne 2f\n"
"pushl 12(%ebp)\npushl 8(%ebp)\ncall _GetHandleInformation@8\njmp 1f\n"
"2:\nmovl $1,%eax\nmovl (%eax),%eax\n"
"1:\nmovl %eax,_observed_eax\npushfl\npopl %eax\nmovl %eax,_observed_flags\ncld\n"
"popl %edi\npopl %esi\npopl %ebx\nleave\nret\n");
static void run(DWORD id){
 HANDLE event=CreateEventA(0,TRUE,FALSE,0);DWORD old;
 mode=id;fault_count=code=access_type=address_match=context_valid=context_flags=0;observed_flags=observed_eax=0;
 page=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);if(!event||!page)ExitProcess(95);
 *(DWORD*)page=0xa5a5a5a5;if(!VirtualProtect(page,4096,PAGE_READONLY,&old))ExitProcess(94);
 probe(event,(DWORD*)page,id==2);
 record(id);record(fault_count);record(code);record(access_type);record(address_match);record(context_valid);record(context_flags);
 record(observed_eax);record(id==0?0:observed_flags&0x8c5);record(*(DWORD*)page);
 CloseHandle(event);VirtualFree(page,0,MEM_RELEASE);
}
void entry(void){
 HANDLE output,thread;DWORD written,id;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
 thread=CreateThread(0,0,watchdog,0,0,0);if(!thread)ExitProcess(93);CloseHandle(thread);
 SetUnhandledExceptionFilter(filter);
 for(id=0;id<3;id++)run(id);
 SetUnhandledExceptionFilter(0);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(output==INVALID_HANDLE_VALUE)ExitProcess(92);
 WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);ExitProcess(written==count*4?0:91);
}
