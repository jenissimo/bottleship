#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[128];
static DWORD count=3;
static struct {int udp_result,udp_error,tcp_result,tcp_error;struct sockaddr_in address;WSAPROTOCOL_INFOA udp,tcp;} packet;
static void record(int value){oracle_results[count++]=(DWORD)value;}
static void clear_bytes(void *ptr,DWORD size){unsigned char *p=ptr;while(size--)*p++=0;}
static void outcome(int value){record(value);record(value<0?WSAGetLastError():0);}
static void finish(void){DWORD written;HANDLE output;oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;
    output=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    if(output!=INVALID_HANDLE_VALUE){WriteFile(output,(const void*)oracle_results,count*4,&written,0);CloseHandle(output);}ExitProcess(output==INVALID_HANDLE_VALUE?1:0);}
static char *decimal(char *out,DWORD value){char digits[16];int count=0;do{digits[count++]='0'+value%10;value/=10;}while(value);while(count)*out++=digits[--count];return out;}
static int parse_child(int *port,DWORD *pid){char *s=GetCommandLineA();int i;for(i=0;s[i];i++)if(s[i]=='-'&&s[i+1]=='-'&&s[i+2]=='c'&&s[i+3]=='h'&&s[i+4]=='i'&&s[i+5]=='l'&&s[i+6]=='d'&&s[i+7]==' '){s+=i+8;*port=0;while(*s>='0'&&*s<='9')*port=*port*10+*s++-'0';while(*s==' ')s++;*pid=0;while(*s>='0'&&*s<='9')*pid=*pid*10+*s++-'0';return 1;}return 0;}
static void child(int port,DWORD target){SOCKET udp,tcp;struct sockaddr_in server;int size,total=0,amount;
    tcp=socket(AF_INET,SOCK_STREAM,6);clear_bytes(&server,sizeof(server));server.sin_family=AF_INET;server.sin_addr.s_addr=htonl(INADDR_LOOPBACK);server.sin_port=htons((u_short)port);if(connect(tcp,(struct sockaddr*)&server,sizeof(server)))ExitProcess(11);
    udp=socket(AF_INET,SOCK_DGRAM,17);packet.address=server;packet.address.sin_port=0;if(bind(udp,(struct sockaddr*)&packet.address,sizeof(packet.address)))ExitProcess(12);size=sizeof(packet.address);getsockname(udp,(struct sockaddr*)&packet.address,&size);
    packet.udp_result=WSADuplicateSocketA(udp,target,&packet.udp);packet.udp_error=packet.udp_result?WSAGetLastError():0;packet.tcp_result=WSADuplicateSocketA(tcp,target,&packet.tcp);packet.tcp_error=packet.tcp_result?WSAGetLastError():0;
    while(total<sizeof(packet)){amount=send(tcp,(char*)&packet+total,sizeof(packet)-total,0);if(amount<=0)ExitProcess(13);total+=amount;}
#ifdef ORACLE_KILL_DUPLICATE_CHILD
    Sleep(INFINITE);
#else
    closesocket(udp);closesocket(tcp);ExitProcess(17);
#endif
}
void entry(void){WSADATA data;SOCKET listener,accepted,udp,tcp,tx,probe;struct sockaddr_in address;STARTUPINFOA startup;PROCESS_INFORMATION process;char command[1024],path[512],bytes[8],*out;DWORD pid,code,timeout=1000;int port,length,i,size,total,amount;u_long nonblock;
    record(WSAStartup(MAKEWORD(2,2),&data));if(parse_child(&port,&pid))child(port,pid);
    listener=socket(AF_INET,SOCK_STREAM,6);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);outcome(bind(listener,(struct sockaddr*)&address,sizeof(address)));size=sizeof(address);getsockname(listener,(struct sockaddr*)&address,&size);listen(listener,4);
    length=GetModuleFileNameA(0,path,sizeof(path));out=command;*out++='"';for(i=0;i<length;i++)*out++=path[i];*out++='"';*out++=' ';*out++='-';*out++='-';*out++='c';*out++='h';*out++='i';*out++='l';*out++='d';*out++=' ';out=decimal(out,ntohs(address.sin_port));*out++=' ';out=decimal(out,GetCurrentProcessId());*out=0;
    clear_bytes(&startup,sizeof(startup));startup.cb=sizeof(startup);clear_bytes(&process,sizeof(process));i=CreateProcessA(0,command,0,0,FALSE,CREATE_NO_WINDOW,0,0,&startup,&process);record(i);if(!i)finish();accepted=accept(listener,0,0);record(accepted!=INVALID_SOCKET);if(accepted==INVALID_SOCKET)finish();
    total=0;while(total<sizeof(packet)){amount=recv(accepted,(char*)&packet+total,sizeof(packet)-total,0);if(amount<=0)break;total+=amount;}record(total==sizeof(packet));record(packet.udp_result);record(packet.udp_error);record(packet.tcp_result);record(packet.tcp_error);
#ifdef ORACLE_KILL_DUPLICATE_CHILD
    record(TerminateProcess(process.hProcess,19));
#else
    record(1);
#endif
    record(WaitForSingleObject(process.hProcess,10000));record(GetExitCodeProcess(process.hProcess,&code));record(code);CloseHandle(process.hThread);CloseHandle(process.hProcess);
    udp=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&packet.udp,0,WSA_FLAG_OVERLAPPED);tcp=WSASocketA(FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,FROM_PROTOCOL_INFO,&packet.tcp,0,WSA_FLAG_OVERLAPPED);record(udp!=INVALID_SOCKET);record(tcp!=INVALID_SOCKET);if(udp==INVALID_SOCKET||tcp==INVALID_SOCKET)finish();
    setsockopt(udp,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);setsockopt(tcp,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);setsockopt(accepted,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,4);
    nonblock=1;ioctlsocket(accepted,FIONBIO,&nonblock);outcome(recv(accepted,bytes,1,0));nonblock=0;ioctlsocket(accepted,FIONBIO,&nonblock);
    tx=socket(AF_INET,SOCK_DGRAM,17);outcome(sendto(tx,"dup",3,0,(struct sockaddr*)&packet.address,sizeof(packet.address)));outcome(recv(udp,bytes,3,0));record(bytes[0]);record(bytes[2]);
    outcome(send(tcp,"xy",2,0));outcome(recv(accepted,bytes,2,MSG_WAITALL));record(bytes[0]);record(bytes[1]);outcome(send(accepted,"z",1,0));outcome(recv(tcp,bytes,1,0));record(bytes[0]);
    outcome(closesocket(tcp));outcome(recv(accepted,bytes,1,0));outcome(closesocket(udp));probe=socket(AF_INET,SOCK_DGRAM,17);outcome(bind(probe,(struct sockaddr*)&packet.address,sizeof(packet.address)));closesocket(probe);closesocket(tx);closesocket(accepted);closesocket(listener);record(WSACleanup());finish();
}
