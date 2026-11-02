#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
/* Finite exception-safe x86 pointer-order experiment. Faults are retained as faults,
 * not changed into guessed WSA errors. No child process, CRT or mapping prerequisite. */
__declspec(dllexport) volatile DWORD oracle_results[8192];
static DWORD used=3,faults,faultcode,faultaccess,faultwhere,aborted;
static SOCKET target;static int operation,option,inputlen;static char *value;static int *length;
static BYTE *valuePage,*lengthPage;
static void rec(DWORD v){if(used<8192)oracle_results[used++]=v;else ExitProcess(91);}
static void zero(void *p,DWORD n){BYTE *b=p;while(n--)*b++=0;}
static DWORD ip(BYTE a,BYTE b,BYTE c,BYTE d){return a|((DWORD)b<<8)|((DWORD)c<<16)|((DWORD)d<<24);}
int __cdecl invoke_option(void){return operation?setsockopt(target,IPPROTO_IP,option,value,inputlen):getsockopt(target,IPPROTO_IP,option,value,length);}
DWORD __cdecl guarded(void);
int __cdecl fault_handler(EXCEPTION_RECORD *record,void *frame,CONTEXT *context,void *dispatcher){
 DWORD *registration=frame;ULONG_PTR address=record->NumberParameters>1?record->ExceptionInformation[1]:0;(void)dispatcher;
 faults++;faultcode=record->ExceptionCode;faultaccess=record->NumberParameters?record->ExceptionInformation[0]:0xfeed;
 faultwhere=address==0?1:address==1?2:address==(ULONG_PTR)value?3:address==(ULONG_PTR)length?4:address==(ULONG_PTR)(valuePage+4096)?5:address==(ULONG_PTR)(lengthPage+4096)?6:7;
 aborted=1;context->Eip=registration[5];context->Esp=registration[4];context->Ebp=(DWORD)frame+44;context->Eax=0xfeed;return 0;
}
__asm__(
".text\n.globl _guarded\n_guarded:\n"
"pushl %ebp\nmovl %esp,%ebp\npushl %ebx\npushl %esi\npushl %edi\nsubl $32,%esp\n"
"movl %fs:0,%eax\nmovl %eax,0(%esp)\nmovl $_fault_handler,4(%esp)\nmovl $-1,8(%esp)\nmovl $-1,12(%esp)\n"
"movl %esp,16(%esp)\nmovl $1f,20(%esp)\nmovl %esp,%fs:0\ncall _invoke_option\n"
"1:\nmovl 0(%esp),%edx\nmovl %edx,%fs:0\naddl $32,%esp\npopl %edi\npopl %esi\npopl %ebx\nleave\nret\n"
);
static DWORD readword(BYTE *p){return p[0]|((DWORD)p[1]<<8)|((DWORD)p[2]<<16)|((DWORD)p[3]<<24);}
static void protect(BYTE *p,DWORD flags){DWORD old;if(!VirtualProtect(p,4096,flags,&old))ExitProcess(94);}
static void probe(int api,int kind,int opt,int mode){
 SOCKET created=socket(AF_INET,kind==1?SOCK_STREAM:SOCK_DGRAM,kind==1?IPPROTO_TCP:IPPROTO_UDP);
 int before,result,last,i,base=opt>=12?8:4;DWORD after=0xfeed;struct ip_mreq m;
 if(created==INVALID_SOCKET)ExitProcess(92);
 target=kind==2?(SOCKET)0x12345678:created;operation=api;option=opt;inputlen=base;
 valuePage=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);lengthPage=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 if(!valuePage||!lengthPage)ExitProcess(93);
 for(i=0;i<8192;i++){valuePage[i]=0xa5;lengthPage[i]=0x5a;}
 value=(char*)valuePage;length=(int*)lengthPage;*length=4;
 m.imr_multiaddr.s_addr=ip(239,255,43,31);m.imr_interface.s_addr=ip(127,0,0,1);
 if(api){
  if(opt==9)*(DWORD*)value=ip(127,0,0,1);else if(opt==10)*(DWORD*)value=7;else if(opt==11)*(DWORD*)value=1;else{*(DWORD*)value=m.imr_multiaddr.s_addr;*(DWORD*)(value+4)=m.imr_interface.s_addr;}
  if(opt==13&&kind==0)setsockopt(target,IPPROTO_IP,IP_ADD_MEMBERSHIP,(char*)&m,8);
  if(mode==1){value=0;inputlen=0;}
  if(mode==2)value=0;
  if(mode==3)value=(char*)1;
  if(mode==4)protect(valuePage,PAGE_READONLY);
  if(mode==5)protect(valuePage,PAGE_NOACCESS);
  if(mode==6){char *original=value;value=(char*)valuePage+4094;for(i=0;i<12;i++)value[i]=original[i];protect(valuePage+4096,PAGE_NOACCESS);}
  if(mode==7)inputlen=-1;
  if(mode==8){inputlen=base-1;protect(valuePage,PAGE_NOACCESS);}
  if(mode==9)inputlen=base+4;
  if(mode==10){char *original=value;value=(char*)valuePage+4096-base;for(i=0;i<base;i++)value[i]=original[i];inputlen=base+4;protect(valuePage+4096,PAGE_NOACCESS);}
 }else{
  if(mode==1)value=0;
  if(mode==2)length=0;
  if(mode==3)protect(valuePage,PAGE_READONLY);
  if(mode==4)protect(lengthPage,PAGE_READONLY);
  if(mode==5)protect(valuePage,PAGE_NOACCESS);
  if(mode==6)protect(lengthPage,PAGE_NOACCESS);
  if(mode==7){value=(char*)valuePage+4094;protect(valuePage+4096,PAGE_NOACCESS);}
  if(mode==8){length=(int*)(lengthPage+4094);*length=4;protect(lengthPage+4096,PAGE_READONLY);}
  if(mode==9){*length=0;protect(valuePage,PAGE_NOACCESS);protect(lengthPage,PAGE_NOACCESS);}
  if(mode==10){*length=0;value=0;}
  if(mode==11){*length=-1;value=0;}
  if(mode==12){*length=1;value=(char*)valuePage+4095;protect(valuePage+4096,PAGE_NOACCESS);}
  if(mode==13||mode==14){*length=8;value=(char*)valuePage+4092;protect(valuePage+4096,mode==13?PAGE_NOACCESS:PAGE_READONLY);}
 }
 before=api?inputlen:(mode==2?0xfeed:mode==9?0:mode==11?-1:mode==12?1:mode>=13?8:4);
 faults=faultcode=faultaccess=faultwhere=aborted=0;WSASetLastError(0x1234);result=guarded();last=WSAGetLastError();
 protect(valuePage,PAGE_READWRITE);protect(valuePage+4096,PAGE_READWRITE);protect(lengthPage,PAGE_READWRITE);protect(lengthPage+4096,PAGE_READWRITE);
 if(!api&&length)after=readword((BYTE*)length);
 if(api&&kind==0){
  if(opt<=11){int n=4;if(getsockopt(target,IPPROTO_IP,opt,(char*)&after,&n))after=0xfeed;}
  else after=setsockopt(target,IPPROTO_IP,IP_DROP_MEMBERSHIP,(char*)&m,8)==0;
 }
 rec(api);rec(kind);rec(opt);rec(mode);rec(before);rec(result);rec(aborted?0:last);rec(faults);rec(faultcode);rec(faultaccess);rec(faultwhere);rec(after);
 if(value&&(DWORD)value>=0x10000){rec(readword((BYTE*)value));rec(readword((BYTE*)value+4));}else{rec(0xfeed);rec(0xfeed);}
 closesocket(created);VirtualFree(valuePage,0,MEM_RELEASE);VirtualFree(lengthPage,0,MEM_RELEASE);
}
static void interface_case(DWORD address){SOCKET s=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);struct ip_mreq m;int result,last,n;DWORD value2;
 rec(9000);rec(address);WSASetLastError(0x1234);result=setsockopt(s,IPPROTO_IP,IP_MULTICAST_IF,(char*)&address,4);last=WSAGetLastError();rec(result);rec(last);
 n=4;value2=0xa5a5a5a5;WSASetLastError(0x1234);result=getsockopt(s,IPPROTO_IP,IP_MULTICAST_IF,(char*)&value2,&n);last=WSAGetLastError();rec(result);rec(last);rec(n);rec(value2);
 m.imr_multiaddr.s_addr=ip(239,255,43,31);m.imr_interface.s_addr=address;WSASetLastError(0x1234);result=setsockopt(s,IPPROTO_IP,IP_ADD_MEMBERSHIP,(char*)&m,8);last=WSAGetLastError();rec(result);rec(last);closesocket(s);
}
void entry(void){WSADATA data;int api,kind,opt,mode;HANDLE file;DWORD written;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);oracle_results[2]=ORACLE_NONCE;rec(WSAStartup(MAKEWORD(2,2),&data));
 for(api=0;api<2;api++)for(kind=0;kind<3;kind++)for(opt=9;opt<=13;opt++)for(mode=0;mode<(api?11:15);mode++)probe(api,kind,opt,mode);
 interface_case(0);interface_case(ip(127,0,0,1));interface_case(ip(127,0,0,2));interface_case(ip(127,1,2,3));interface_case(ip(203,0,113,1));
 rec(WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,0);
 if(file==INVALID_HANDLE_VALUE)ExitProcess(95);if(!WriteFile(file,(const void*)oracle_results,used*4,&written,0)||written!=used*4)ExitProcess(96);CloseHandle(file);ExitProcess(0);
}
