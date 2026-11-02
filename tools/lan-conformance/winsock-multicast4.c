#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

/* Independent x86 Windows measurements, not copied provider code. No shared mapping,
 * child process, host-adapter enumeration, or Internet endpoint is required.
 * Receive phases use only explicit loopback multicast and bounded nonblocking reads.
 * Option errors/defaults are exact observations; delivery is environmental raw evidence. */
__declspec(dllexport) volatile DWORD oracle_results[4096];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD used=3,seq;
static void record(int v){oracle_results[used++]=(DWORD)v;}
static void zero(void *p,DWORD n){unsigned char *b=p;while(n--)*b++=0;}
static unsigned long address(unsigned a,unsigned b,unsigned c,unsigned d){return a|(b<<8)|(c<<16)|(d<<24);}
static SOCKET udp(void){return socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);}
static void get_option(SOCKET s,int option,int capacity){
    unsigned char bytes[8];int length=capacity,r;DWORD i;for(i=0;i<8;i++)bytes[i]=0xa5;
    WSASetLastError(12345);r=getsockopt(s,IPPROTO_IP,option,(char*)bytes,&length);
    record(1000+(int)seq++);record(option);record(capacity);record(r);record(WSAGetLastError());record(length);
    record(bytes[0]|bytes[1]<<8|bytes[2]<<16|bytes[3]<<24);record(bytes[4]|bytes[5]<<8|bytes[6]<<16|bytes[7]<<24);
}
static void set_option(SOCKET s,int option,int length,int value){
    int r;WSASetLastError(12345);r=setsockopt(s,IPPROTO_IP,option,(char*)&value,length);
    record(2000+(int)seq++);record(option);record(length);record(value);record(r);record(WSAGetLastError());
}
static void member(SOCKET s,int option,int length,unsigned long group,unsigned long iface){
    struct { struct ip_mreq m; DWORD tail; } request;int r;zero(&request,sizeof(request));
    request.m.imr_multiaddr.s_addr=group;request.m.imr_interface.s_addr=iface;request.tail=0x12345678;
    WSASetLastError(12345);r=setsockopt(s,IPPROTO_IP,option,(char*)&request,length);
    record(3000+(int)seq++);record(option);record(length);record((int)group);record((int)iface);record(r);record(WSAGetLastError());
}
static void fresh_member(int kind,int length,unsigned long group,unsigned long iface){SOCKET s=udp();member(s,kind,length,group,iface);closesocket(s);}
static int bind_to(SOCKET s,unsigned long ip,unsigned short port){
    struct sockaddr_in a;zero(&a,sizeof(a));a.sin_family=AF_INET;a.sin_addr.s_addr=ip;a.sin_port=port;
    WSASetLastError(12345);int r=bind(s,(struct sockaddr*)&a,sizeof(a));record(r);record(WSAGetLastError());return r;
}
static void probe_receive(SOCKET s,int phase,int receiver){
    fd_set f;struct timeval timeout;struct sockaddr_in from;int n=sizeof(from),r,selected,select_error;char data[16];
    zero(&from,sizeof(from));zero(data,sizeof(data));FD_ZERO(&f);FD_SET(s,&f);timeout.tv_sec=0;timeout.tv_usec=100000;
    WSASetLastError(12345);selected=select(0,&f,0,0,&timeout);select_error=WSAGetLastError();
    r=selected>0?recvfrom(s,data,sizeof(data),0,(struct sockaddr*)&from,&n):-2;
    record(4000+phase*10+receiver);record(selected);record(select_error);record(r);record(selected>0?WSAGetLastError():0);
    record((unsigned char)data[0]);record(selected>0?n:0);record(selected>0&&from.sin_family==AF_INET);record(selected>0&&from.sin_addr.s_addr==address(127,0,0,1));
}
static void send_phase(SOCKET tx,SOCKET *rx,int phase,unsigned long group,unsigned short port){
    struct sockaddr_in to;int r,i;char data=(char)('A'+phase);zero(&to,sizeof(to));to.sin_family=AF_INET;to.sin_addr.s_addr=group;to.sin_port=port;
    WSASetLastError(12345);r=sendto(tx,&data,1,0,(struct sockaddr*)&to,sizeof(to));record(3900+phase);record(r);record(WSAGetLastError());
    for(i=0;i<3;i++)probe_receive(rx[i],phase,i);
}
static void delivery(void){
    SOCKET rx[3],tx;struct sockaddr_in bound;int n=sizeof(bound),i,one=1;u_long nonblocking=1;
    unsigned long loop=address(127,0,0,1),g=address(239,255,42,17),h=address(239,255,42,18);
    record(3800);for(i=0;i<3;i++){rx[i]=udp();record(rx[i]!=INVALID_SOCKET);setsockopt(rx[i],SOL_SOCKET,SO_REUSEADDR,(char*)&one,4);ioctlsocket(rx[i],FIONBIO,&nonblocking);}
    bind_to(rx[0],INADDR_ANY,0);zero(&bound,sizeof(bound));record(getsockname(rx[0],(struct sockaddr*)&bound,&n));record(bound.sin_port!=0);
    bind_to(rx[1],INADDR_ANY,bound.sin_port);bind_to(rx[2],INADDR_ANY,bound.sin_port);
    tx=udp();record(tx!=INVALID_SOCKET);bind_to(tx,loop,0);set_option(tx,IP_MULTICAST_IF,4,(int)loop);set_option(tx,IP_MULTICAST_TTL,4,0);set_option(tx,IP_MULTICAST_LOOP,4,1);
    member(rx[0],IP_ADD_MEMBERSHIP,8,g,loop);member(rx[1],IP_ADD_MEMBERSHIP,8,h,loop);
    send_phase(tx,rx,0,g,bound.sin_port);send_phase(tx,rx,1,h,bound.sin_port);
    member(rx[1],IP_ADD_MEMBERSHIP,8,g,loop);send_phase(tx,rx,2,g,bound.sin_port);
    set_option(rx[0],IP_MULTICAST_LOOP,4,0);send_phase(tx,rx,3,g,bound.sin_port);
    set_option(tx,IP_MULTICAST_LOOP,4,0);send_phase(tx,rx,4,g,bound.sin_port);
    set_option(rx[0],IP_MULTICAST_LOOP,4,1);set_option(tx,IP_MULTICAST_LOOP,4,1);
    member(rx[0],IP_DROP_MEMBERSHIP,8,g,loop);send_phase(tx,rx,5,g,bound.sin_port);
    member(rx[1],IP_DROP_MEMBERSHIP,8,g,loop);send_phase(tx,rx,6,g,bound.sin_port);
    for(i=0;i<3;i++)closesocket(rx[i]);closesocket(tx);
}
static void legacy(void){
    typedef int (WSAAPI *SetOpt)(SOCKET,int,int,const char*,int);
    typedef int (WSAAPI *GetOpt)(SOCKET,int,int,char*,int*);
    HMODULE module=LoadLibraryA("wsock32.dll");SetOpt set=module?(SetOpt)GetProcAddress(module,"setsockopt"):0;GetOpt get=module?(GetOpt)GetProcAddress(module,"getsockopt"):0;
    SOCKET s=udp();struct ip_mreq request;int value=0x5a5a5a5a,length=4,r;record(5000);record(module!=0);record(set!=0&&get!=0);
    if(set&&get){WSASetLastError(12345);r=get(s,IPPROTO_IP,3,(char*)&value,&length);record(r);record(WSAGetLastError());record(length);record(value);
    value=7;WSASetLastError(12345);r=set(s,IPPROTO_IP,3,(char*)&value,4);record(r);record(WSAGetLastError());get_option(s,IP_MULTICAST_TTL,4);
    request.imr_multiaddr.s_addr=address(239,255,42,17);request.imr_interface.s_addr=address(127,0,0,1);
    WSASetLastError(12345);r=set(s,IPPROTO_IP,5,(char*)&request,8);record(r);record(WSAGetLastError());
    WSASetLastError(12345);r=set(s,IPPROTO_IP,6,(char*)&request,8);record(r);record(WSAGetLastError());}
    closesocket(s);if(module)FreeLibrary(module);
}
static void finish(void){DWORD bytes;HANDLE f;oracle_results[0]=0x42534c4e;oracle_results[1]=used;
    f=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(f!=INVALID_HANDLE_VALUE){WriteFile(f,(const void*)oracle_results,used*4,&bytes,0);CloseHandle(f);}ExitProcess(f==INVALID_HANDLE_VALUE?1:0);}
void entry(void){
    WSADATA startup;SOCKET s,tcp;int i;unsigned long loop=address(127,0,0,1),g=address(239,255,42,17);int lengths[]={0,1,2,3,4,8};
    oracle_results[2]=ORACLE_NONCE;record(WSAStartup(MAKEWORD(2,2),&startup));record(sizeof(struct ip_mreq));
    s=udp();record(s!=INVALID_SOCKET);get_option(s,IP_MULTICAST_IF,4);get_option(s,IP_MULTICAST_TTL,4);get_option(s,IP_MULTICAST_LOOP,4);
    for(i=0;i<6;i++){get_option(s,IP_MULTICAST_TTL,lengths[i]);get_option(s,IP_MULTICAST_LOOP,lengths[i]);}
    get_option(s,IP_ADD_MEMBERSHIP,4);get_option(s,IP_DROP_MEMBERSHIP,4);
    for(i=0;i<6;i++)set_option(s,IP_MULTICAST_TTL,lengths[i],17);
    set_option(s,IP_MULTICAST_TTL,4,-1);set_option(s,IP_MULTICAST_TTL,4,256);set_option(s,IP_MULTICAST_TTL,4,255);
    get_option(s,IP_MULTICAST_TTL,4);set_option(s,IP_MULTICAST_LOOP,4,2);get_option(s,IP_MULTICAST_LOOP,4);
    set_option(s,IP_MULTICAST_LOOP,4,256);get_option(s,IP_MULTICAST_LOOP,4);set_option(s,IP_MULTICAST_LOOP,1,1);get_option(s,IP_MULTICAST_LOOP,4);
    set_option(s,IP_MULTICAST_IF,1,(int)loop);set_option(s,IP_MULTICAST_IF,4,(int)loop);get_option(s,IP_MULTICAST_IF,4);closesocket(s);
    s=udp();member(s,IP_DROP_MEMBERSHIP,8,g,loop);member(s,IP_ADD_MEMBERSHIP,8,g,loop);member(s,IP_ADD_MEMBERSHIP,8,g,loop);member(s,IP_DROP_MEMBERSHIP,8,g,loop);member(s,IP_DROP_MEMBERSHIP,8,g,loop);closesocket(s);
    fresh_member(IP_ADD_MEMBERSHIP,0,g,loop);fresh_member(IP_ADD_MEMBERSHIP,7,g,loop);fresh_member(IP_ADD_MEMBERSHIP,12,g,loop);
    fresh_member(IP_ADD_MEMBERSHIP,8,address(127,0,0,1),loop);fresh_member(IP_ADD_MEMBERSHIP,8,0,loop);
    fresh_member(IP_ADD_MEMBERSHIP,8,g,address(203,0,113,1));fresh_member(IP_ADD_MEMBERSHIP,8,g,0);
    tcp=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);get_option(tcp,IP_MULTICAST_TTL,4);set_option(tcp,IP_MULTICAST_TTL,4,1);member(tcp,IP_ADD_MEMBERSHIP,8,g,loop);closesocket(tcp);
    delivery();legacy();record(WSACleanup());finish();
}
