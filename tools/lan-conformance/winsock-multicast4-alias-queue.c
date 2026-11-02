#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
/* Stage29 independent native Windows x86 experiment, no CRT or child process.
 * All traffic is TTL0 on explicit loopback; numeric ephemeral ports are normalized.
 * Tagged scalar records distinguish option cache, membership and arrival queue state. */
__declspec(dllexport) volatile DWORD oracle_results[2048];
static DWORD used=3;
static void rec(DWORD v){if(used<2048)oracle_results[used++]=v;else ExitProcess(91);}
static void zero(void *p,DWORD n){BYTE *b=p;while(n--)*b++=0;}
static DWORD ip(BYTE a,BYTE b,BYTE c,BYTE d){return a|((DWORD)b<<8)|((DWORD)c<<16)|((DWORD)d<<24);}
static void result(DWORD tag,int value){DWORD error=WSAGetLastError();rec(tag);rec(value);rec(error);}
static SOCKET make_udp(DWORD tag){SOCKET s;WSASetLastError(0x1234);s=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);result(tag,s==INVALID_SOCKET?-1:0);return s;}
static void opt(SOCKET s,DWORD tag,int option,DWORD value){WSASetLastError(0x1234);result(tag,setsockopt(s,IPPROTO_IP,option,(char*)&value,4));}
static void get(SOCKET s,DWORD tag,int option){DWORD value=0xa5a5a5a5;int n=4,r;WSASetLastError(0x1234);r=getsockopt(s,IPPROTO_IP,option,(char*)&value,&n);result(tag,r);rec(n);rec(value);}
static void options(SOCKET s,DWORD tag){get(s,tag,IP_MULTICAST_IF);get(s,tag+1,IP_MULTICAST_TTL);get(s,tag+2,IP_MULTICAST_LOOP);}
static void member(SOCKET s,DWORD tag,int operation){struct ip_mreq m;m.imr_multiaddr.s_addr=ip(239,255,43,29);m.imr_interface.s_addr=ip(127,0,0,1);WSASetLastError(0x1234);result(tag,setsockopt(s,IPPROTO_IP,operation,(char*)&m,sizeof(m)));}
static void close_socket(SOCKET s,DWORD tag){WSASetLastError(0x1234);result(tag,closesocket(s));}
static SOCKET duplicate(SOCKET source,DWORD tag){WSAPROTOCOL_INFOA info;SOCKET copy;zero(&info,sizeof(info));WSASetLastError(0x1234);result(tag,WSADuplicateSocketA(source,GetCurrentProcessId(),&info));rec(info.dwProviderReserved!=0);
 WSASetLastError(0x1234);copy=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);result(tag+1,copy==INVALID_SOCKET?-1:0);rec(copy==(SOCKET)info.dwProviderReserved);return copy;}
static u_short bind_socket(SOCKET s,DWORD tag,DWORD addr,u_short port){struct sockaddr_in a;int n=sizeof(a);zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=addr;a.sin_port=port;WSASetLastError(0x1234);result(tag,bind(s,(struct sockaddr*)&a,sizeof(a)));WSASetLastError(0x1234);result(tag+1,getsockname(s,(struct sockaddr*)&a,&n));rec(n);rec(a.sin_port!=0);return a.sin_port;}
static int readable(SOCKET s,DWORD tag,long usec){fd_set set;struct timeval t;int r;FD_ZERO(&set);FD_SET(s,&set);t.tv_sec=usec/1000000;t.tv_usec=usec%1000000;WSASetLastError(0x1234);r=select(0,&set,0,0,&t);result(tag,r);return r;}
static void receive(SOCKET s,DWORD tag){char data[8];struct sockaddr_in from;int n=sizeof(from),r;zero(data,sizeof(data));zero(&from,sizeof(from));WSASetLastError(0x1234);r=recvfrom(s,data,sizeof(data),0,(struct sockaddr*)&from,&n);result(tag,r);rec((BYTE)data[0]);rec(n);rec(from.sin_family==AF_INET);rec(from.sin_addr.s_addr==ip(127,0,0,1));}
static void send_packet(SOCKET tx,DWORD tag,u_short port,char marker){struct sockaddr_in to;zero(&to,sizeof(to));to.sin_family=AF_INET;to.sin_addr.s_addr=ip(239,255,43,29);to.sin_port=port;WSASetLastError(0x1234);result(tag,sendto(tx,&marker,1,0,(struct sockaddr*)&to,sizeof(to)));}
static void options_and_membership(void){SOCKET source=make_udp(100),copy;options(source,110);opt(source,120,IP_MULTICAST_TTL,7);opt(source,121,IP_MULTICAST_LOOP,0);opt(source,122,IP_MULTICAST_IF,ip(127,0,0,1));member(source,123,IP_ADD_MEMBERSHIP);
 copy=duplicate(source,130);options(source,140);options(copy,150);
 opt(copy,160,IP_MULTICAST_TTL,9);opt(copy,161,IP_MULTICAST_LOOP,1);opt(copy,162,IP_MULTICAST_IF,0);options(source,170);options(copy,180);
 member(copy,190,IP_ADD_MEMBERSHIP);member(copy,191,IP_DROP_MEMBERSHIP);member(source,192,IP_DROP_MEMBERSHIP);member(source,193,IP_ADD_MEMBERSHIP);
 close_socket(source,194);options(copy,200);member(copy,210,IP_DROP_MEMBERSHIP);close_socket(copy,211);
}
static void queue_and_close(void){SOCKET source=make_udp(300),copy,tx,another,fresh;u_long nonblocking=1;u_short port;int one=1,selected;
 setsockopt(source,SOL_SOCKET,SO_REUSEADDR,(char*)&one,4);port=bind_socket(source,301,INADDR_ANY,0);ioctlsocket(source,FIONBIO,&nonblocking);member(source,304,IP_ADD_MEMBERSHIP);copy=duplicate(source,305);close_socket(source,307);
 tx=make_udp(310);bind_socket(tx,311,ip(127,0,0,1),0);opt(tx,314,IP_MULTICAST_IF,ip(127,0,0,1));opt(tx,315,IP_MULTICAST_TTL,0);opt(tx,316,IP_MULTICAST_LOOP,1);
 send_packet(tx,320,port,'A');selected=readable(copy,321,1000000);member(copy,322,IP_DROP_MEMBERSHIP);if(selected>0)receive(copy,323);else{rec(323);rec(0xfeed);}
 send_packet(tx,324,port,'B');selected=readable(copy,325,100000);if(selected>0)receive(copy,326);else{rec(326);rec(0xfeed);}
 member(copy,330,IP_ADD_MEMBERSHIP);send_packet(tx,331,port,'C');selected=readable(copy,332,1000000);opt(copy,333,IP_MULTICAST_LOOP,0);if(selected>0)receive(copy,334);else{rec(334);rec(0xfeed);}
 send_packet(tx,335,port,'D');selected=readable(copy,336,100000);if(selected>0)receive(copy,337);else{rec(337);rec(0xfeed);}
 opt(copy,340,IP_MULTICAST_LOOP,1);another=duplicate(copy,341);close_socket(copy,343);send_packet(tx,344,port,'E');selected=readable(another,345,1000000);if(selected>0)receive(another,346);else{rec(346);rec(0xfeed);}
 close_socket(another,347);fresh=make_udp(350);setsockopt(fresh,SOL_SOCKET,SO_REUSEADDR,(char*)&one,4);bind_socket(fresh,351,INADDR_ANY,port);ioctlsocket(fresh,FIONBIO,&nonblocking);options(fresh,354);send_packet(tx,357,port,'F');selected=readable(fresh,358,100000);if(selected>0)receive(fresh,359);else{rec(359);rec(0xfeed);}close_socket(fresh,360);close_socket(tx,361);
}
static void provider_cleanup(void){SOCKET source=make_udp(400),copy;WSAPROTOCOL_INFOA info;WSADATA startup;zero(&info,sizeof(info));opt(source,401,IP_MULTICAST_TTL,19);opt(source,402,IP_MULTICAST_LOOP,0);opt(source,403,IP_MULTICAST_IF,ip(127,0,0,1));member(source,404,IP_ADD_MEMBERSHIP);
 WSASetLastError(0x1234);result(405,WSADuplicateSocketA(source,GetCurrentProcessId(),&info));rec(info.dwProviderReserved!=0);WSASetLastError(0x1234);result(406,WSACleanup());WSASetLastError(0x1234);result(407,WSAStartup(MAKEWORD(2,2),&startup));WSASetLastError(0x1234);copy=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&info,0,WSA_FLAG_OVERLAPPED);result(408,copy==INVALID_SOCKET?-1:0);rec(copy==(SOCKET)info.dwProviderReserved);options(copy,410);member(copy,420,IP_DROP_MEMBERSHIP);close_socket(copy,421);
}
void entry(void){WSADATA data;HANDLE file;DWORD written;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);oracle_results[2]=ORACLE_NONCE;WSASetLastError(0x1234);result(1,WSAStartup(MAKEWORD(2,2),&data));options_and_membership();queue_and_close();provider_cleanup();WSASetLastError(0x1234);result(999,WSACleanup());oracle_results[0]=0x42534c4e;oracle_results[1]=used;
 file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,0);if(file==INVALID_HANDLE_VALUE)ExitProcess(92);if(!WriteFile(file,(const void*)oracle_results,used*4,&written,0)||written!=used*4)ExitProcess(93);CloseHandle(file);ExitProcess(0);}
