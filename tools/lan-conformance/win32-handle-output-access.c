#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[512];
static DWORD count=3,mode,fault_count,fault_code,fault_write,fault_address,aborted;
static BYTE *page;static DWORD *destination;
static void record(DWORD value){oracle_results[count++]=value;}
DWORD __cdecl probe2(HANDLE handle,DWORD *output);
int __cdecl probe_handler(EXCEPTION_RECORD *record,void *frame,CONTEXT *context,void *dispatcher){
 DWORD *registration=(DWORD*)frame,old;(void)dispatcher;fault_count++;fault_code=record->ExceptionCode;
 fault_write=record->NumberParameters>0?record->ExceptionInformation[0]:0xfeed;
 fault_address=record->NumberParameters>1?(record->ExceptionInformation[1]==(ULONG_PTR)destination?1:record->ExceptionInformation[1]==(ULONG_PTR)(page+4096)?2:3):0;
 if(fault_count==1&&mode==14){if(VirtualAlloc(page,4096,MEM_COMMIT,PAGE_READWRITE)==page)return 0;}
 if(fault_count==1&&mode==15){if(VirtualProtect(page,4096,PAGE_READWRITE,&old))return 0;}
 aborted=1;context->Eip=registration[5];context->Esp=registration[4];context->Ebp=(DWORD)frame+44;context->Eax=0xfeed;return 0;
}
__asm__(
".text\n"
".globl _probe2\n"
"_probe2:\n"
"pushl %ebp\nmovl %esp,%ebp\npushl %ebx\npushl %esi\npushl %edi\nsubl $32,%esp\n"
"movl %fs:0,%eax\nmovl %eax,0(%esp)\nmovl $_probe_handler,4(%esp)\nmovl $-1,8(%esp)\nmovl $-1,12(%esp)\n"
"movl %esp,16(%esp)\nmovl $1f,20(%esp)\nmovl %esp,%fs:0\n"
"pushl 12(%ebp)\npushl 8(%ebp)\ncall _GetHandleInformation@8\n"
"1:\nmovl 0(%esp),%edx\nmovl %edx,%fs:0\naddl $32,%esp\npopl %edi\npopl %esi\npopl %ebx\nleave\nret\n"
);
static void run(DWORD id){
 DWORD old,result,last;HANDLE handle=CreateEventA(0,TRUE,FALSE,0);
 mode=id;fault_count=fault_code=fault_write=fault_address=aborted=0;
 page=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);destination=(DWORD*)page;
 if(!handle||!page)ExitProcess(30);*(DWORD*)page=0xa5a5a5a5;
 if(id==1||id==15)VirtualProtect(page,4096,PAGE_READONLY,&old);
 if(id==2)VirtualProtect(page,4096,PAGE_NOACCESS,&old);
 if(id==3||id==4||id==14)VirtualFree(page,4096,MEM_DECOMMIT);
 if(id==3){VirtualFree(page,0,MEM_RELEASE);page=VirtualAlloc(page,8192,MEM_RESERVE,PAGE_READWRITE);destination=(DWORD*)page;if(!page)ExitProcess(31);}
 if(id==5)VirtualFree(page,0,MEM_RELEASE);
 if(id==6||id==12)destination=0;if(id==7)destination=(DWORD*)1;
 if(id>=8&&id<=10){destination=(DWORD*)(page+4094);*(DWORD*)destination=0xa5a5a5a5;if(id==8)VirtualProtect(page+4096,4096,PAGE_READONLY,&old);if(id==9)VirtualProtect(page+4096,4096,PAGE_NOACCESS,&old);if(id==10)VirtualFree(page+4096,4096,MEM_DECOMMIT);}
 if(id==11||id==12){CloseHandle(handle);handle=(HANDLE)0x12345678;}
 if(id==13)SetHandleInformation(handle,HANDLE_FLAG_PROTECT_FROM_CLOSE,HANDLE_FLAG_PROTECT_FROM_CLOSE);
 SetLastError(0x2345);result=probe2(handle,destination);last=GetLastError();
 record(id);record(result);record(aborted?0:last);record(fault_count);record(fault_code);record(fault_write);record(fault_address);
 if(id==0||id==1||id==8||id==9||id==10||id==11||id==13||id==14||id==15){record(*(BYTE*)destination!=0xa5);}else record(0xfeed);
 if(id==13)SetHandleInformation(handle,HANDLE_FLAG_PROTECT_FROM_CLOSE,0);
 if(id!=11&&id!=12)CloseHandle(handle);if(id!=5)VirtualFree(page,0,MEM_RELEASE);
}
void entry(void){
 DWORD id,written;HANDLE output;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
 for(id=0;id<16;id++)run(id);
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
 output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);
}
