#define _WIN32_WINNT 0x0600
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
#define RESET_IOCTL 0x9800000c
/* NEW source-only follow-up. No measurement until explicit native grant.
 * IOCP+APC rejected-control physical effect: 2 families x 2 initial states
 * x queued54/noQueued54. All real results retained. No API hooks/recovery,
 * external endpoints, guessed atomicity, or dynamic compared identifiers. */
__declspec(dllexport) volatile DWORD oracle_results[4096];
static DWORD used=3,start,portUsed=3,portAudit[128],orphanCallbacks;
static HANDLE watchdog;
struct peer {int family;SOCKET client,live;SOCKADDR_STORAGE dead,self,toLive;};
struct slot {WSAOVERLAPPED ov;DWORD option,returned,calls,error,bytes,flags,sameThread,thread;};
static struct slot slots[8];static DWORD slotCount;
static void rec(DWORD x){if(used>=4096)ExitProcess(91);oracle_results[used++]=x;}
static void begin(DWORD tag){rec(tag);start=used;rec(0);}
static void end(void){oracle_results[start]=used-start-1;}
static void fill(void*p,DWORD n,BYTE value){BYTE*b=p;while(n--)*b++=value;}
static void save(const char*name,const DWORD*data,DWORD words){HANDLE f;DWORD written;
 f=CreateFileA(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
 if(f==INVALID_HANDLE_VALUE||!WriteFile(f,data,words*4,&written,0)||written!=words*4)ExitProcess(92);CloseHandle(f);}
static void checkpoint(const char*name){oracle_results[0]=0x42534c4e;oracle_results[1]=used;oracle_results[2]=ORACLE_NONCE;save(name,(const DWORD*)oracle_results,used);}
static void save_ports(void){portAudit[0]=0x42535054;portAudit[1]=portUsed;portAudit[2]=ORACLE_NONCE;save("udp-port-audit.bin",portAudit,portUsed);}
static void fail(DWORD code){checkpoint("checkpoint.bin");save_ports();ExitProcess(code);}
static DWORD WINAPI deadline(void*unused){(void)unused;Sleep(20000);ExitProcess(90);return 0;}
static LONG WINAPI unexpected(EXCEPTION_POINTERS*p){begin(0xfffe);rec(p->ExceptionRecord->ExceptionCode);
 rec(p->ExceptionRecord->NumberParameters?p->ExceptionRecord->ExceptionInformation[0]:0xffffffff);end();fail(107);return EXCEPTION_EXECUTE_HANDLER;}
static int address_size(int family){return family==AF_INET?16:28;}
static WORD port_of(const SOCKADDR_STORAGE*a){return ntohs(a->ss_family==AF_INET?((const struct sockaddr_in*)a)->sin_port:((const struct sockaddr_in6*)a)->sin6_port);}
static SOCKET udp(int family){return WSASocketA(family,SOCK_DGRAM,IPPROTO_UDP,0,0,WSA_FLAG_OVERLAPPED);}
static void bind_loop(SOCKET*s,int family,SOCKADDR_STORAGE*a){int n,attempt;
 for(attempt=0;attempt<4;attempt++){
  fill(a,sizeof(*a),0);a->ss_family=family;
  if(family==AF_INET)((struct sockaddr_in*)a)->sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  else ((struct sockaddr_in6*)a)->sin6_addr.u.Byte[15]=1;
  if(bind(*s,(struct sockaddr*)a,address_size(family)))fail(93);
  n=sizeof(*a);if(getsockname(*s,(struct sockaddr*)a,&n))fail(93);
  if(port_of(a)!=55172&&port_of(a)!=55173){
   if(portUsed+2>128)fail(94);portAudit[portUsed++]=family;portAudit[portUsed++]=port_of(a);save_ports();return;
  }
  closesocket(*s);*s=udp(family);if(*s==INVALID_SOCKET)fail(93);
 }
 fail(93);
}
static void prepare(struct peer*p,int family){SOCKET dead;char byte='W',data[8];int r;u_long nb=1;fd_set rd;struct timeval t;
 fill(p,sizeof(*p),0);p->family=family;p->client=udp(family);p->live=udp(family);dead=udp(family);
 if(p->client==INVALID_SOCKET||p->live==INVALID_SOCKET||dead==INVALID_SOCKET)fail(95);
 bind_loop(&dead,family,&p->dead);bind_loop(&p->client,family,&p->self);bind_loop(&p->live,family,&p->toLive);
 if(ioctlsocket(p->client,FIONBIO,&nb))fail(95);
 if(sendto(p->client,&byte,1,0,(struct sockaddr*)&p->dead,address_size(family))!=1)fail(96);
 FD_ZERO(&rd);FD_SET(dead,&rd);t.tv_sec=1;t.tv_usec=0;r=select(0,&rd,0,0,&t);
 if(r!=1||recvfrom(dead,data,sizeof(data),0,0,0)!=1)fail(96);
 if(closesocket(dead))fail(96);
}
static int ready(SOCKET s,int millis){fd_set rd,ex;struct timeval t;int r,e;
 FD_ZERO(&rd);FD_ZERO(&ex);FD_SET(s,&rd);FD_SET(s,&ex);t.tv_sec=millis/1000;t.tv_usec=(millis%1000)*1000;
 WSASetLastError(0x1234);r=select(0,&rd,0,&ex,&t);e=WSAGetLastError();rec(r);rec(e);rec(FD_ISSET(s,&rd)!=0);rec(FD_ISSET(s,&ex)!=0);
 return r==1&&FD_ISSET(s,&rd)!=0;
}
static void normal_option(SOCKET s,DWORD value,DWORD tag){DWORD bytes=0xabcdef01;int r,e;
 WSASetLastError(0x1234);r=WSAIoctl(s,RESET_IOCTL,&value,4,0,0,&bytes,0,0);e=WSAGetLastError();
 begin(tag);rec(value);rec(((BYTE*)&value)[0]);rec(r);rec(e);rec(bytes);end();
 if(r)fail(108); /* prerequisite initial state, not the rejected combination */
}
static int dead_send(struct peer*p,DWORD tag,int millis){char byte='X';int r,e,rd;
 WSASetLastError(0x1234);r=sendto(p->client,&byte,1,0,(struct sockaddr*)&p->dead,address_size(p->family));e=WSAGetLastError();
 begin(tag);rec(r);rec(e);rd=ready(p->client,millis);end();return r==1&&rd;
}
static void receive(struct peer*p,DWORD tag){BYTE data[8];int r,e;fill(data,sizeof(data),0xa5);
 WSASetLastError(0x1234);r=recvfrom(p->client,(char*)data,sizeof(data),0,0,0);e=WSAGetLastError();
 begin(tag);rec(r);rec(e);rec(data[0]);end();
}
static void live_control(struct peer*p,DWORD tag){char byte='B',data[8];int r,e;
 WSASetLastError(0x1234);r=sendto(p->live,&byte,1,0,(struct sockaddr*)&p->self,address_size(p->family));e=WSAGetLastError();
 begin(tag);rec(r);rec(e);ready(p->client,1000);fill(data,sizeof(data),0xa5);
 WSASetLastError(0x1234);r=recvfrom(p->client,data,sizeof(data),0,0,0);e=WSAGetLastError();
 rec(r);rec(e);rec(r==1&&data[0]=='B');end();
}
static void CALLBACK completed(DWORD error,DWORD bytes,LPWSAOVERLAPPED ov,DWORD flags){DWORD i;
 for(i=0;i<slotCount;i++)if(ov==&slots[i].ov){struct slot*s=&slots[i];
  s->calls++;s->error=error;s->bytes=bytes;s->flags=flags;s->sameThread=GetCurrentThreadId()==s->thread;return;
 }
 orphanCallbacks++;
}
static void one(int family,int initialOn,int queued){struct peer p;struct slot*s=&slots[slotCount++];HANDLE port;int r,e,a,b,c;
 DWORD slept,packetBytes=0xdeadbeef;ULONG_PTR key=0x87654321;OVERLAPPED*packet=(OVERLAPPED*)1;
 begin(0x1000);rec(family);rec(initialOn);rec(queued);end();
 prepare(&p,family);normal_option(p.client,initialOn,0x1001);
 /* Baseline proves the initial physical state before any IOCP association. */
 dead_send(&p,0x1010,initialOn?1000:200);receive(&p,0x1011);live_control(&p,0x1012);
 if(queued){
  /* Generate an actual queued54 while ON, then restore the desired initial
   * state before the target call. Do not consume that error prematurely. */
  normal_option(p.client,1,0x1020);if(!dead_send(&p,0x1021,1000))fail(110);
  normal_option(p.client,initialOn,0x1022);
 }
 SetLastError(0x1234);port=CreateIoCompletionPort((HANDLE)p.client,0,42,0);e=GetLastError();
 begin(0x1030);rec(port!=0);rec(e);end();if(!port)fail(109);
 fill(s,sizeof(*s),0);s->thread=GetCurrentThreadId();s->option=initialOn?0:1;s->returned=0xabcdef01;
 s->error=s->bytes=s->flags=0xdeadbeef;
 s->ov.Internal=0x11111111;s->ov.InternalHigh=0x22222222;s->ov.Offset=0x33333333;s->ov.OffsetHigh=0x44444444;
 WSASetLastError(0x1234);r=WSAIoctl(p.client,RESET_IOCTL,&s->option,4,0,0,&s->returned,&s->ov,completed);e=WSAGetLastError();
 begin(0x1031);rec(s->option);rec(((BYTE*)&s->option)[0]);rec(r);rec(e);rec(s->returned);
 rec(s->ov.Internal);rec(s->ov.InternalHigh);rec(s->ov.Offset);rec(s->ov.OffsetHigh);end();
 slept=SleepEx(50,TRUE);SetLastError(0x1234);r=GetQueuedCompletionStatus(port,&packetBytes,&key,&packet,50);e=GetLastError();
 begin(0x1032);rec(slept);rec(s->calls);rec(s->error);rec(s->bytes);rec(s->flags);rec(s->sameThread);rec(orphanCallbacks);
 rec(r);rec(e);rec(packet==&s->ov);rec(packet==0);rec(packetBytes);rec((DWORD)key);rec(s->ov.Internal);rec(s->ov.InternalHigh);end();
 if(queued)receive(&p,0x1040); /* old queued error is separate from a fresh one */
 /* No ordinary reset-toggle call after the rejected operation until this
  * fresh error is observed. Either physical result is recorded, not guessed. */
 dead_send(&p,0x1050,500);receive(&p,0x1051);live_control(&p,0x1052);
 a=closesocket(p.client);b=closesocket(p.live);c=CloseHandle(port);
 begin(0x1060);rec(a==0);rec(b==0);rec(c!=0);end();
 checkpoint("checkpoint.bin");save_ports();
}
void entry(void){WSADATA data;DWORD i;int family,initialOn,queued,r,e;
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);SetUnhandledExceptionFilter(unexpected);
 watchdog=CreateThread(0,0,deadline,0,0,0);if(!watchdog)ExitProcess(97);
 WSASetLastError(0x1234);r=WSAStartup(MAKEWORD(2,2),&data);e=WSAGetLastError();
 begin(0x0010);rec(r);rec(e);rec(data.wVersion);end();if(r)fail(98);
 for(family=0;family<2;family++)for(initialOn=0;initialOn<2;initialOn++)for(queued=0;queued<2;queued++)
  one(family?AF_INET6:AF_INET,initialOn,queued);
 SleepEx(1,TRUE);
 for(i=0;i<slotCount;i++){struct slot*s=&slots[i];begin(0x3002);rec(i);rec(s->calls);rec(s->error);rec(s->bytes);rec(s->flags);
  rec(s->sameThread);rec(s->ov.Internal);rec(s->ov.InternalHigh);end();}
 WSASetLastError(0x1234);r=WSACleanup();e=WSAGetLastError();begin(0x0011);rec(r);rec(e);end();
 begin(0xffff);rec(0x53544147);end();checkpoint("lan-oracle.bin");save_ports();CloseHandle(watchdog);ExitProcess(0);
}
