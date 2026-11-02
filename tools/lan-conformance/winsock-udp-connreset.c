#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define RESET_IOCTL 0x9800000c
/* Stage30 portable preparation: NEW producer, not yet compiled or measured.
 * SAME-PE candidate: no dynamic handles, TIDs, addresses or ports in oracle_results.
 * Actual bound ports are written ONLY to udp-port-audit.bin for external retirement.
 * Reuses measured v2/v3 safe pointer/physical/completion branches. No WSARecvMsg,
 * shared mapping, custom SEH trampoline, Internet endpoint, or fixture retry. */
__declspec(dllexport) volatile DWORD oracle_results[32768];
static DWORD used=3,recordStart,portUsed=3;
static DWORD portAudit[1024];
static SOCKET target;static BYTE *input,*output,*inPage,*retPage,*outPage;
static DWORD inlen,outlen,*returned;static WSAOVERLAPPED *operation;
static LPWSAOVERLAPPED_COMPLETION_ROUTINE routine;
static HANDLE watchdog;
static void rec(DWORD x){if(used<32768)oracle_results[used++]=x;else ExitProcess(91);}
static void begin(DWORD tag){rec(tag);recordStart=used;rec(0);}
static void end(void){oracle_results[recordStart]=used-recordStart-1;}
static void fill(void*p,DWORD n,BYTE x){BYTE*b=p;while(n--)*b++=x;}
static DWORD word(const BYTE*p){return p[0]|((DWORD)p[1]<<8)|((DWORD)p[2]<<16)|((DWORD)p[3]<<24);}
static void protect(BYTE*p,DWORD perm){DWORD old;if(!VirtualProtect(p,4096,perm,&old))ExitProcess(92);}
static DWORD WINAPI deadline(void *unused){(void)unused;Sleep(45000);ExitProcess(90);return 0;}
static void checkpoint(const char*name){HANDLE f;DWORD written;oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;
 f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(f==INVALID_HANDLE_VALUE||!WriteFile(f,(const void*)oracle_results,used*4,&written,0)||written!=used*4)ExitProcess(93);CloseHandle(f);}
static void audit_port(int family,WORD port){if(portUsed+2>1024)ExitProcess(105);portAudit[portUsed++]=family;portAudit[portUsed++]=port;}
static void save_ports(void){HANDLE f;DWORD written;portAudit[0]=0x42535054;portAudit[1]=portUsed;portAudit[2]=ORACLE_NONCE;
 f=CreateFileA("udp-port-audit.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(f==INVALID_HANDLE_VALUE||!WriteFile(f,portAudit,portUsed*4,&written,0)||written!=portUsed*4)ExitProcess(106);CloseHandle(f);}
static void invoke(void){int r,e;WSASetLastError(0x1234);
 r=WSAIoctl(target,RESET_IOCTL,input,inlen,output,outlen,returned,operation,routine);
 e=WSAGetLastError();rec(r);rec(e);}
static SOCKET make_socket(int kind,DWORD flags){int family=kind==1||kind==3?AF_INET6:AF_INET,type=kind>=2?SOCK_STREAM:SOCK_DGRAM;return WSASocketA(family,type,type==SOCK_STREAM?IPPROTO_TCP:IPPROTO_UDP,0,0,flags);}
static void matrix(int version,int kind,int mode){
 SOCKET created=make_socket(kind==4?0:kind,WSA_FLAG_OVERLAPPED);DWORD *store;int n;
 if(created==INVALID_SOCKET)ExitProcess(94);
 inPage=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 retPage=VirtualAlloc(0,8192,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 outPage=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
 if(!inPage||!retPage||!outPage)ExitProcess(95);
 fill(inPage,8192,0xa5);fill(retPage,8192,0x5a);fill(outPage,4096,0xc3);
 target=kind==4?(SOCKET)0x12345678:created;input=inPage;inlen=4;output=0;outlen=0;returned=(DWORD*)retPage;operation=0;routine=0;
 *(DWORD*)input=1;*returned=0xabcdef01;
 if(mode==1)*(DWORD*)input=0;
 if(mode==2)input=0;
 if(mode==3){input=0;inlen=0;}
 if(mode==4)inlen=0;
 if(mode==5)inlen=1;
 if(mode==6)inlen=3;
 if(mode==7)inlen=8;
 if(mode==8)protect(inPage,PAGE_READONLY);
 if(mode==9)protect(inPage,PAGE_NOACCESS);
 if(mode==10){input=inPage+4094;*(DWORD*)input=1;protect(inPage+4096,PAGE_NOACCESS);}
 if(mode==11)returned=0;
 if(mode==12)returned=(DWORD*)1;
 if(mode==13)protect(retPage,PAGE_READONLY);
 if(mode==14)protect(retPage,PAGE_NOACCESS);
 if(mode==15){returned=(DWORD*)(retPage+4094);*returned=0xabcdef01;protect(retPage+4096,PAGE_READONLY);}
 if(mode==16){output=outPage;outlen=4;protect(outPage,PAGE_NOACCESS);}
 if(mode==17)input=(BYTE*)1;
 if(mode==18){output=0;outlen=4;}
 if(mode==19)*(DWORD*)input=256;
 if(mode==20)inlen=0xffffffff;
 if(mode==21){input=inPage+4092;*(DWORD*)input=1;inlen=8;protect(inPage+4096,PAGE_NOACCESS);}
 if(mode==22){protect(inPage,PAGE_NOACCESS);returned=(DWORD*)1;}
 if(mode==23){protect(inPage,PAGE_NOACCESS);protect(retPage,PAGE_READONLY);}
 if(mode==24){output=(BYTE*)1;outlen=0xffffffff;}
 begin(0x1001);rec(version);rec(kind);rec(mode);rec(inlen);rec(outlen);invoke();
 protect(inPage,PAGE_READWRITE);protect(inPage+4096,PAGE_READWRITE);protect(retPage,PAGE_READWRITE);protect(retPage+4096,PAGE_READWRITE);protect(outPage,PAGE_READWRITE);
 store=(DWORD*)(mode==15?retPage+4094:retPage);rec(word((BYTE*)store));rec(word(inPage));rec(word(outPage));end();
 closesocket(created);VirtualFree(inPage,0,MEM_RELEASE);VirtualFree(retPage,0,MEM_RELEASE);VirtualFree(outPage,0,MEM_RELEASE);
}
static int family_bytes(int family){return family==AF_INET?16:28;}
static WORD port_of(const SOCKADDR_STORAGE*a){return ntohs(a->ss_family==AF_INET?((const struct sockaddr_in*)a)->sin_port:((const struct sockaddr_in6*)a)->sin6_port);}
static void bind_loop(SOCKET *s,int family,SOCKADDR_STORAGE*a){int n,tries;for(tries=0;tries<4;tries++){
 fill(a,sizeof(*a),0);a->ss_family=family;if(family==AF_INET)((struct sockaddr_in*)a)->sin_addr.s_addr=htonl(INADDR_LOOPBACK);else ((struct sockaddr_in6*)a)->sin6_addr.u.Byte[15]=1;
 if(bind(*s,(struct sockaddr*)a,family_bytes(family)))ExitProcess(96);n=sizeof(*a);if(getsockname(*s,(struct sockaddr*)a,&n))ExitProcess(96);
 if(port_of(a)!=55172&&port_of(a)!=55173){audit_port(family,port_of(a));save_ports();return;}
 closesocket(*s);*s=socket(family,SOCK_DGRAM,IPPROTO_UDP);if(*s==INVALID_SOCKET)ExitProcess(96);
 }ExitProcess(96);}
static void pair_result(int r){int e=WSAGetLastError();rec(r);rec(e);}
static void ioctl_reset(SOCKET s,DWORD value,DWORD tag){DWORD bytes=0xabcdef01;int r;WSASetLastError(0x1234);r=WSAIoctl(s,RESET_IOCTL,&value,4,0,0,&bytes,0,0);begin(tag);pair_result(r);rec(bytes);end();}
struct peers{int family;SOCKET client,live;SOCKADDR_STORAGE dead,toLive,self;};
static int ready(SOCKET s,int millis){fd_set rd,ex;struct timeval t;int r;FD_ZERO(&rd);FD_ZERO(&ex);FD_SET(s,&rd);FD_SET(s,&ex);t.tv_sec=millis/1000;t.tv_usec=millis%1000*1000;WSASetLastError(0x1234);r=select(0,&rd,0,&ex,&t);rec(r);rec(WSAGetLastError());rec(FD_ISSET(s,&rd)!=0);rec(FD_ISSET(s,&ex)!=0);return r;}
static void prepare(struct peers*p,int family){SOCKET dead;char marker='w';char scratch[8];u_long nb=1;int n;fd_set rd;struct timeval t;
 fill(p,sizeof(*p),0);p->family=family;dead=socket(family,SOCK_DGRAM,IPPROTO_UDP);p->live=socket(family,SOCK_DGRAM,IPPROTO_UDP);p->client=socket(family,SOCK_DGRAM,IPPROTO_UDP);
 if(dead==INVALID_SOCKET||p->live==INVALID_SOCKET||p->client==INVALID_SOCKET)ExitProcess(97);
 bind_loop(&dead,family,&p->dead);bind_loop(&p->live,family,&p->toLive);bind_loop(&p->client,family,&p->self);ioctlsocket(p->client,FIONBIO,&nb);
 if(sendto(p->client,&marker,1,0,(struct sockaddr*)&p->dead,family_bytes(family))!=1)ExitProcess(98);
 FD_ZERO(&rd);FD_SET(dead,&rd);t.tv_sec=0;t.tv_usec=500000;
 if(select(0,&rd,0,0,&t)!=1||recvfrom(dead,scratch,8,0,0,0)!=1)ExitProcess(98);
 closesocket(dead);
}
static void receive_error(struct peers*p,SOCKET source,DWORD tag){BYTE data[8];int r;(void)p;
 fill(data,sizeof(data),0xa5);WSASetLastError(0x1234);r=recvfrom(source,(char*)data,8,0,0,0);
 begin(tag);pair_result(r);rec(data[0]);end();}
static int deadWait=1000;
static void dead_send(struct peers*p,SOCKET source,DWORD tag){char m='x';int r;WSASetLastError(0x1234);r=sendto(source,&m,1,0,(struct sockaddr*)&p->dead,family_bytes(p->family));begin(tag);pair_result(r);ready(source,deadWait);end();}
static void live_control(struct peers*p,SOCKET source,DWORD tag){char m='B',data[8];int r;
 WSASetLastError(0x1234);r=sendto(p->live,&m,1,0,(struct sockaddr*)&p->self,family_bytes(p->family));begin(tag);pair_result(r);ready(source,1000);
 fill(data,8,0xa5);WSASetLastError(0x1234);r=recvfrom(source,data,8,0,0,0);pair_result(r);rec(r==1&&data[0]=='B');end();}
static void toggle_alias(int family){struct peers p;deadWait=1000;WSAPROTOCOL_INFOA info;SOCKET alias;int r;prepare(&p,family);fill(&info,sizeof(info),0);
 begin(0x2100);rec(family);end();WSASetLastError(0x1234);r=WSADuplicateSocketA(p.client,GetCurrentProcessId(),&info);begin(0x2101);pair_result(r);rec(info.dwProviderReserved!=0);end();
 if(r)ExitProcess(99);WSASetLastError(0x1234);alias=WSASocketA(-1,-1,-1,&info,0,WSA_FLAG_OVERLAPPED);begin(0x2102);pair_result(alias==INVALID_SOCKET?-1:0);rec(alias==(SOCKET)info.dwProviderReserved);end();if(alias==INVALID_SOCKET)ExitProcess(99);
 dead_send(&p,p.client,0x2110);receive_error(&p,p.client,0x2111);live_control(&p,p.client,0x2112);
 ioctl_reset(alias,0,0x2120);deadWait=200;dead_send(&p,p.client,0x2121);receive_error(&p,p.client,0x2122);live_control(&p,p.client,0x2123);
 ioctl_reset(p.client,1,0x2130);deadWait=1000;dead_send(&p,alias,0x2131);receive_error(&p,alias,0x2132);live_control(&p,alias,0x2133);
 ioctl_reset(alias,0,0x2140);deadWait=200;closesocket(p.client);p.client=INVALID_SOCKET;dead_send(&p,alias,0x2141);receive_error(&p,alias,0x2142);live_control(&p,alias,0x2143);
 closesocket(alias);closesocket(p.live);
}
static void pending_policy(int family,int mode){struct peers p;prepare(&p,family);begin(0x2200);rec(family);rec(mode);end();
 deadWait=mode==1?200:1000;if(mode==1)ioctl_reset(p.client,0,0x2201);
 dead_send(&p,p.client,0x2202);
 ioctl_reset(p.client,mode==1?1:0,0x2203);if(mode==2)ioctl_reset(p.client,1,0x2204);
 receive_error(&p,p.client,0x2205);live_control(&p,p.client,0x2206);closesocket(p.client);closesocket(p.live);
}
struct completion_slot { WSAOVERLAPPED ov; DWORD option,returnedBytes,calls,error,bytes,flags,sameThread,thread; };
static struct completion_slot completionSlots[64];static DWORD completionCount,orphanCallbacks;static int initiallySignaled=0,returnedMode=0;
static void CALLBACK completed(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){DWORD i;for(i=0;i<completionCount;i++)if(ov==&completionSlots[i].ov){
 struct completion_slot*s=&completionSlots[i];s->calls++;s->error=error;s->bytes=bytes;s->flags=flags;s->sameThread=GetCurrentThreadId()==s->thread;return;}orphanCallbacks++;}
static void completion_case(int kind,int flags,int mode){
 struct completion_slot*slot=&completionSlots[completionCount++];WSAOVERLAPPED*ov=&slot->ov;SOCKET s=make_socket(kind,flags);
 HANDLE event=CreateEventA(0,TRUE,initiallySignaled,0),port=0;DWORD cb=0xdeadbeef,slept,wait;ULONG_PTR key=0x87654321;OVERLAPPED *dequeued=(OVERLAPPED*)1;int r,e;
 if(s==INVALID_SOCKET||!event)ExitProcess(100);fill(slot,sizeof(*slot),0);slot->returnedBytes=0xabcdef01;slot->error=slot->bytes=slot->flags=0xdeadbeef;slot->thread=GetCurrentThreadId();
 ov->Internal=0x11111111;ov->InternalHigh=0x22222222;ov->Offset=0x33333333;ov->OffsetHigh=0x44444444;ov->hEvent=mode==1?event:0;
 if(mode==4||mode==5){SetLastError(0x1234);port=CreateIoCompletionPort((HANDLE)s,0,42,0);e=GetLastError();}else e=0xfeed;
 begin(0x3000);rec(kind);rec(flags);rec(mode);rec(s!=INVALID_SOCKET);rec(event!=0);rec(mode==4||mode==5);rec(port!=0);rec(e);rec(initiallySignaled);rec(returnedMode);end();
 target=s;input=(BYTE*)&slot->option;inlen=4;output=0;outlen=0;returned=returnedMode==1?0:returnedMode==2?(DWORD*)1:&slot->returnedBytes;operation=mode?ov:0;routine=mode==2||mode==3||mode==5?completed:0;
 if(mode==3)operation=0;
 begin(0x3001);rec(kind);rec(flags);rec(mode);invoke();rec(slot->returnedBytes);rec(ov->Internal);rec(ov->InternalHigh);rec(ov->Offset);rec(ov->OffsetHigh);
 wait=WaitForSingleObject(event,0);rec(wait);slept=SleepEx(100,TRUE);rec(slept);rec(slot->calls);rec(slot->error);rec(slot->bytes);rec(slot->flags);rec(slot->sameThread);rec(orphanCallbacks);
 rec(WaitForSingleObject(event,0));rec(ov->Internal);rec(ov->InternalHigh);
 if(port){SetLastError(0x1234);r=GetQueuedCompletionStatus(port,&cb,&key,&dequeued,100);e=GetLastError();rec(r);rec(e);rec(dequeued==ov);rec(dequeued==0);rec(cb);rec((DWORD)key);}else{rec(0xfeed);rec(0xfeed);rec(0xfeed);rec(0xfeed);rec(0xfeed);rec(0xfeed);}
 rec(ov->Internal);rec(ov->InternalHigh);end();
 closesocket(s);SleepEx(1,TRUE);CloseHandle(event);if(port)CloseHandle(port);
}

static void boolean_policy(int family){
 struct peers p;DWORD values[8]={0,1,256,65536,16777216,257,0xffffffff,2},bytes;int i,r;
 prepare(&p,family);
 for(i=0;i<8;i++){bytes=0xabcdef01;WSASetLastError(0x1234);r=WSAIoctl(p.client,RESET_IOCTL,&values[i],4,0,0,&bytes,0,0);
 begin(0x2300);rec(family);rec(values[i]);pair_result(r);rec(bytes);end();deadWait=(values[i]&255)?1000:200;dead_send(&p,p.client,0x2301);receive_error(&p,p.client,0x2302);live_control(&p,p.client,0x2303);}
 closesocket(p.client);closesocket(p.live);
}
static void invalid_mutation(int family,int mode){struct peers p;deadWait=200;DWORD option=1,bytes=0xabcdef01;BYTE *bad;prepare(&p,family);ioctl_reset(p.client,0,0x2400);
 bad=VirtualAlloc(0,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);if(!bad)ExitProcess(102);*(DWORD*)bad=1;protect(bad,PAGE_NOACCESS);
 target=p.client;input=mode==1?bad:(BYTE*)&option;inlen=mode==2?0:4;output=0;outlen=0;returned=mode==0?0:&bytes;operation=0;routine=0;
 begin(0x2401);rec(family);rec(mode);invoke();rec(bytes);end();dead_send(&p,p.client,0x2402);receive_error(&p,p.client,0x2403);live_control(&p,p.client,0x2404);
 protect(bad,PAGE_READWRITE);VirtualFree(bad,0,MEM_RELEASE);closesocket(p.client);closesocket(p.live);
}
static void unbound_case(int family,int flags){SOCKET s=WSASocketA(family,SOCK_DGRAM,IPPROTO_UDP,0,0,flags);SOCKADDR_STORAGE a;int n=sizeof(a),r;DWORD option=0,bytes=0xabcdef01;
 if(s==INVALID_SOCKET)ExitProcess(103);fill(&a,sizeof(a),0);WSASetLastError(0x1234);r=getsockname(s,(struct sockaddr*)&a,&n);
 begin(0x2500);rec(family);rec(flags);pair_result(r);rec(n);rec(a.ss_family);rec(port_of(&a)==0);end();
 WSASetLastError(0x1234);r=WSAIoctl(s,RESET_IOCTL,&option,4,0,0,&bytes,0,0);begin(0x2501);pair_result(r);rec(bytes);end();
 fill(&a,sizeof(a),0);n=sizeof(a);WSASetLastError(0x1234);r=getsockname(s,(struct sockaddr*)&a,&n);begin(0x2502);pair_result(r);rec(n);rec(a.ss_family);rec(port_of(&a)==0);end();closesocket(s);
}
static void reserved_cleanup(int family){struct peers p;deadWait=200;WSAPROTOCOL_INFOA clientInfo,liveInfo;WSADATA data;int r;SOCKET imported;prepare(&p,family);
 begin(0x2600);rec(family);end();ioctl_reset(p.client,0,0x2601);
 WSASetLastError(0x1234);r=WSADuplicateSocketA(p.client,GetCurrentProcessId(),&clientInfo);begin(0x2602);pair_result(r);rec(clientInfo.dwProviderReserved!=0);end();if(r)ExitProcess(104);
 WSASetLastError(0x1234);r=WSADuplicateSocketA(p.live,GetCurrentProcessId(),&liveInfo);begin(0x2603);pair_result(r);rec(liveInfo.dwProviderReserved!=0);end();if(r)ExitProcess(104);
 WSASetLastError(0x1234);r=WSACleanup();begin(0x2604);pair_result(r);end();
 WSASetLastError(0x1234);r=WSAStartup(MAKEWORD(2,2),&data);begin(0x2605);pair_result(r);end();if(r)ExitProcess(104);
 WSASetLastError(0x1234);imported=WSASocketA(-1,-1,-1,&clientInfo,0,WSA_FLAG_OVERLAPPED);begin(0x2606);pair_result(imported==INVALID_SOCKET?-1:0);rec(imported==(SOCKET)clientInfo.dwProviderReserved);end();if(imported==INVALID_SOCKET)ExitProcess(104);p.client=imported;
 WSASetLastError(0x1234);imported=WSASocketA(-1,-1,-1,&liveInfo,0,WSA_FLAG_OVERLAPPED);begin(0x2607);pair_result(imported==INVALID_SOCKET?-1:0);rec(imported==(SOCKET)liveInfo.dwProviderReserved);end();if(imported==INVALID_SOCKET)ExitProcess(104);p.live=imported;
 dead_send(&p,p.client,0x2608);receive_error(&p,p.client,0x2609);live_control(&p,p.client,0x260a);
 ioctl_reset(p.client,1,0x260b);deadWait=1000;dead_send(&p,p.client,0x260c);receive_error(&p,p.client,0x260d);live_control(&p,p.client,0x260e);closesocket(p.client);closesocket(p.live);
}
static LONG WINAPI unexpected(EXCEPTION_POINTERS*p){begin(0xfffe);rec(p->ExceptionRecord->ExceptionCode);
 rec(p->ExceptionRecord->NumberParameters?p->ExceptionRecord->ExceptionInformation[0]:0xffffffff);end();
 checkpoint("checkpoint.bin");save_ports();ExitProcess(107);return EXCEPTION_EXECUTE_HANDLER;}
void entry(void){WSADATA data;int family,kind,flags,mode,version;DWORD option=1,bytes=0xabcdef01;
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);SetUnhandledExceptionFilter(unexpected);
 watchdog=CreateThread(0,0,deadline,0,0,0);if(!watchdog)ExitProcess(101);
 target=(SOCKET)0x12345678;input=(BYTE*)&option;inlen=4;output=0;outlen=0;returned=&bytes;operation=0;routine=0;
 begin(0x0001);invoke();rec(bytes);end();
 for(version=0;version<2;version++){
  begin(0x0010);rec(version?0x202:0x101);rec(WSAStartup(version?MAKEWORD(2,2):MAKEWORD(1,1),&data));rec(data.wVersion);end();
  for(kind=0;kind<5;kind++)for(mode=0;mode<25;mode++)matrix(version?0x202:0x101,kind,mode);
  begin(0x0011);rec(WSACleanup());end();
 }
 checkpoint("checkpoint.bin");save_ports();
 begin(0x0010);rec(0x202);rec(WSAStartup(MAKEWORD(2,2),&data));rec(data.wVersion);end();
 for(family=0;family<2;family++){
  toggle_alias(family?AF_INET6:AF_INET);
  for(mode=0;mode<3;mode++)pending_policy(family?AF_INET6:AF_INET,mode);
  boolean_policy(family?AF_INET6:AF_INET);
  for(mode=0;mode<3;mode++)invalid_mutation(family?AF_INET6:AF_INET,mode);
  for(flags=0;flags<2;flags++)unbound_case(family?AF_INET6:AF_INET,flags);
  reserved_cleanup(family?AF_INET6:AF_INET);
 }
 checkpoint("checkpoint.bin");save_ports();
 // Only UDP completion variants are selected. TCP basic validation is in the matrix.
 // Mode5 records rejected IOCP+APC IOSB/packet/callback outcomes, never toggle state.
 for(kind=0;kind<2;kind++){
  returnedMode=0;for(flags=0;flags<2;flags++)for(mode=0;mode<6;mode++)completion_case(kind,flags,mode);
  returnedMode=1;completion_case(kind,1,1);completion_case(kind,1,2);completion_case(kind,1,4);
  returnedMode=2;completion_case(kind,1,1);
 }
 for(flags=0;flags<(int)completionCount;flags++){
  struct completion_slot*slot=&completionSlots[flags];begin(0x3002);rec(flags);rec(slot->calls);
  rec(slot->error);rec(slot->bytes);rec(slot->flags);rec(slot->sameThread);rec(slot->ov.Internal);rec(slot->ov.InternalHigh);end();
 }
 begin(0x0011);rec(WSACleanup());end();begin(0xffff);rec(0x53544147);end();
 checkpoint("lan-oracle.bin");save_ports();CloseHandle(watchdog);ExitProcess(0);
}
