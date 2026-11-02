#define _WIN32_WINNT 0x0601
#define NTDDI_VERSION 0x06010000
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <stddef.h>
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
__declspec(dllexport) volatile DWORD oracle_results[2048];
static DWORD count=3;static BYTE buffer[131072];static DWORD callbacks,callback_error,callback_bytes,callback_same,callback_owner,callback_flags,expected_thread;static WSAOVERLAPPED *expected_ov;
static void record(DWORD n){oracle_results[count++]=n;}static void fill(void *p,BYTE n,DWORD size){BYTE *b=p;while(size--)*b++=n;}
static void result(DWORD n){record(n);record(GetLastError());}
static void CALLBACK complete(DWORD error,DWORD bytes,WSAOVERLAPPED *ov,DWORD flags){callbacks++;callback_error=error;callback_bytes=bytes;callback_same=ov==expected_ov;callback_owner=GetCurrentThreadId()==expected_thread;callback_flags=flags;}
static BOOL inside(const void *p,DWORD n){return (const BYTE*)p>=buffer&&(const BYTE*)p+n<=buffer+sizeof(buffer);}
static void interface_list(int family,int type){
 SOCKET s=socket(family,type,type==SOCK_STREAM?IPPROTO_TCP:IPPROTO_UDP);DWORD bytes=0,n,required,cap,index;int value;DWORD capacities[7];struct sockaddr_storage local;int local_size=sizeof(local);
 record(family);record(type);record(s!=INVALID_SOCKET);fill(buffer,0xa5,sizeof(buffer));SetLastError(0x1234);value=WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,buffer,sizeof(buffer),&bytes,0,0);result(value);
 record(bytes!=0&&bytes%sizeof(INTERFACE_INFO)==0);required=bytes;
 BOOL families=TRUE,ports=TRUE,padding=TRUE;for(index=0;index<bytes/sizeof(INTERFACE_INFO);index++){
  INTERFACE_INFO *entry=(INTERFACE_INFO*)buffer+index;families&=entry->iiAddress.Address.sa_family==AF_INET;ports&=entry->iiAddress.AddressIn.sin_port==0;
  for(n=16;n<sizeof(sockaddr_gen);n++)padding&=((BYTE*)&entry->iiAddress)[n]==0&&((BYTE*)&entry->iiBroadcastAddress)[n]==0&&((BYTE*)&entry->iiNetmask)[n]==0;
 }
 record(families);record(ports);record(padding);record(bytes<sizeof(buffer)&&buffer[bytes]==0xa5);
 record(getsockname(s,(struct sockaddr*)&local,&local_size)==0);
 capacities[0]=0;capacities[1]=1;capacities[2]=75;capacities[3]=76;capacities[4]=required?required-1:0;capacities[5]=required;capacities[6]=required+1;
 for(index=0;index<7;index++){fill(buffer,0xa5,sizeof(buffer));cap=capacities[index];bytes=0xdeadbeef;SetLastError(0x1234);value=WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,buffer,cap,&bytes,0,0);result(value);record(bytes==0?0:bytes==required?1:2);record(buffer[0]!=0xa5);}
 closesocket(s);
}
static void overlapped(DWORD mode){
 SOCKET s=WSASocketA(AF_INET,SOCK_DGRAM,IPPROTO_UDP,0,0,mode==3?0:WSA_FLAG_OVERLAPPED);WSAOVERLAPPED ov;DWORD bytes=0xdeadbeef,got=0xfeed,flags=0xfeed;HANDLE port=0;ULONG_PTR key=0;LPOVERLAPPED returned=0;DWORD owner=GetCurrentThreadId();
 fill(&ov,0,sizeof(ov));ov.Internal=0xfeed;ov.InternalHigh=0xbeef;ov.Offset=0xaaaa;ov.hEvent=mode==2?0:CreateEventA(0,TRUE,FALSE,0);if(mode==2)port=CreateIoCompletionPort((HANDLE)s,0,42,0);
 callbacks=callback_error=callback_bytes=callback_same=callback_owner=callback_flags=0;expected_ov=&ov;expected_thread=owner;record(mode);SetLastError(0x1234);
 int value=WSAIoctl(s,SIO_GET_INTERFACE_LIST,0,0,buffer,sizeof(buffer),&bytes,&ov,mode==1?complete:0);result(value);record(bytes!=0&&bytes!=0xdeadbeef&&bytes%76==0);record(ov.Internal);record(ov.InternalHigh==bytes?1:ov.InternalHigh==0xbeef?2:3);record(ov.Offset);
 record(ov.hEvent?WaitForSingleObject(ov.hEvent,100):0xfeed);record(SleepEx(30,TRUE));record(callbacks);record(callback_error);record(callback_bytes==bytes);record(callback_same);record(callback_owner);record(callback_flags);
 if(port){SetLastError(0x2345);result(GetQueuedCompletionStatus(port,&got,&key,&returned,100));record(got==bytes);record(key);record(returned==&ov);CloseHandle(port);}
 else{record(0xfeed);record(0xfeed);record(0xfeed);record(0xfeed);record(0xfeed);}
 SetLastError(0x3456);result(WSAGetOverlappedResult(s,&ov,&got,FALSE,&flags));record(got==bytes);record(flags);
 if(ov.hEvent)CloseHandle(ov.hEvent);closesocket(s);(void)owner;
}
static void adapters_info(void){
 ULONG size=0;SetLastError(0x1234);result(GetAdaptersInfo(0,&size));record(size>=sizeof(IP_ADAPTER_INFO));size=sizeof(buffer);fill(buffer,0xa5,sizeof(buffer));SetLastError(0x1234);DWORD status=GetAdaptersInfo((IP_ADAPTER_INFO*)buffer,&size);result(status);record(size==sizeof(buffer));
 BOOL valid=TRUE;DWORD n=0;IP_ADAPTER_INFO *entry=(IP_ADAPTER_INFO*)buffer;
 if(!status)while(entry&&n++<256){if(!inside(entry,sizeof(*entry))){valid=FALSE;break;}valid&=entry->AddressLength<=8&&entry->Type!=MIB_IF_TYPE_LOOPBACK;entry=entry->Next;}
 record(!status&&n>0&&n<256&&valid);record(buffer[sizeof(buffer)-1]==0xa5);
}
static void adapters_addresses(ULONG family,ULONG flags){
 ULONG size=0;DWORD status;record(family);record(flags);SetLastError(0x1234);result(GetAdaptersAddresses(family,flags,0,0,&size));record(size>=sizeof(IP_ADAPTER_ADDRESSES));
 size=sizeof(buffer);fill(buffer,0xa5,sizeof(buffer));SetLastError(0x1234);status=GetAdaptersAddresses(family,flags,0,(IP_ADAPTER_ADDRESSES*)buffer,&size);result(status);record(size==sizeof(buffer));
 BOOL valid=TRUE,families=TRUE;DWORD n=0;IP_ADAPTER_ADDRESSES *entry=(IP_ADAPTER_ADDRESSES*)buffer;
 if(!status)while(entry&&n++<256){if(!inside(entry,sizeof(*entry))){valid=FALSE;break;}IP_ADAPTER_UNICAST_ADDRESS *address=entry->FirstUnicastAddress;DWORD k=0;while(address&&k++<512){if(!inside(address,sizeof(*address))||!inside(address->Address.lpSockaddr,address->Address.iSockaddrLength)){valid=FALSE;break;}families&=!family||address->Address.lpSockaddr->sa_family==family;address=address->Next;}valid&=k<512;entry=entry->Next;}
 record(!status&&n>0&&n<256&&valid);record(families);record(!status?((IP_ADAPTER_ADDRESSES*)buffer)->Length:0);record(buffer[sizeof(buffer)-1]==0xa5);
}
#define FIELD(type,member) record(offsetof(type,member))
void entry(void){
 WSADATA w;DWORD i;HANDLE file;DWORD written;
 record(sizeof(IP_ADAPTER_ADDRESSES));FIELD(IP_ADAPTER_ADDRESSES,Next);FIELD(IP_ADAPTER_ADDRESSES,AdapterName);FIELD(IP_ADAPTER_ADDRESSES,FirstUnicastAddress);FIELD(IP_ADAPTER_ADDRESSES,FirstAnycastAddress);FIELD(IP_ADAPTER_ADDRESSES,FirstMulticastAddress);FIELD(IP_ADAPTER_ADDRESSES,FirstDnsServerAddress);FIELD(IP_ADAPTER_ADDRESSES,DnsSuffix);FIELD(IP_ADAPTER_ADDRESSES,Description);FIELD(IP_ADAPTER_ADDRESSES,FriendlyName);FIELD(IP_ADAPTER_ADDRESSES,PhysicalAddress);FIELD(IP_ADAPTER_ADDRESSES,PhysicalAddressLength);FIELD(IP_ADAPTER_ADDRESSES,Flags);FIELD(IP_ADAPTER_ADDRESSES,Mtu);FIELD(IP_ADAPTER_ADDRESSES,IfType);FIELD(IP_ADAPTER_ADDRESSES,OperStatus);FIELD(IP_ADAPTER_ADDRESSES,Ipv6IfIndex);FIELD(IP_ADAPTER_ADDRESSES,ZoneIndices);FIELD(IP_ADAPTER_ADDRESSES,FirstPrefix);FIELD(IP_ADAPTER_ADDRESSES,TransmitLinkSpeed);FIELD(IP_ADAPTER_ADDRESSES,ReceiveLinkSpeed);FIELD(IP_ADAPTER_ADDRESSES,FirstWinsServerAddress);FIELD(IP_ADAPTER_ADDRESSES,FirstGatewayAddress);FIELD(IP_ADAPTER_ADDRESSES,Ipv4Metric);FIELD(IP_ADAPTER_ADDRESSES,Ipv6Metric);FIELD(IP_ADAPTER_ADDRESSES,Luid);FIELD(IP_ADAPTER_ADDRESSES,Dhcpv4Server);FIELD(IP_ADAPTER_ADDRESSES,CompartmentId);FIELD(IP_ADAPTER_ADDRESSES,NetworkGuid);FIELD(IP_ADAPTER_ADDRESSES,ConnectionType);FIELD(IP_ADAPTER_ADDRESSES,TunnelType);FIELD(IP_ADAPTER_ADDRESSES,Dhcpv6Server);FIELD(IP_ADAPTER_ADDRESSES,Dhcpv6ClientDuid);FIELD(IP_ADAPTER_ADDRESSES,Dhcpv6ClientDuidLength);FIELD(IP_ADAPTER_ADDRESSES,Dhcpv6Iaid);FIELD(IP_ADAPTER_ADDRESSES,FirstDnsSuffix);
 record(sizeof(IP_ADAPTER_UNICAST_ADDRESS));FIELD(IP_ADAPTER_UNICAST_ADDRESS,Next);FIELD(IP_ADAPTER_UNICAST_ADDRESS,Address);FIELD(IP_ADAPTER_UNICAST_ADDRESS,PrefixOrigin);FIELD(IP_ADAPTER_UNICAST_ADDRESS,DadState);FIELD(IP_ADAPTER_UNICAST_ADDRESS,ValidLifetime);FIELD(IP_ADAPTER_UNICAST_ADDRESS,OnLinkPrefixLength);record(sizeof(IP_ADAPTER_PREFIX));FIELD(IP_ADAPTER_PREFIX,Next);FIELD(IP_ADAPTER_PREFIX,Address);FIELD(IP_ADAPTER_PREFIX,PrefixLength);
 adapters_info();for(i=0;i<3;i++)adapters_addresses(i==0?AF_UNSPEC:i==1?AF_INET:AF_INET6,0);adapters_addresses(AF_INET,1);adapters_addresses(AF_INET6,16);adapters_addresses(999,0);adapters_addresses(AF_UNSPEC,0x80000000);
 record(WSAStartup(MAKEWORD(2,2),&w));interface_list(AF_INET,SOCK_DGRAM);interface_list(AF_INET,SOCK_STREAM);interface_list(AF_INET6,SOCK_DGRAM);for(i=0;i<4;i++)overlapped(i);record(WSACleanup());
 oracle_results[0]=0x42534c4e;oracle_results[1]=count;oracle_results[2]=ORACLE_NONCE;file=CreateFileA("lan-oracle.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);if(file==INVALID_HANDLE_VALUE)ExitProcess(1);if(!WriteFile(file,(const void*)oracle_results,count*4,&written,0)||written!=count*4)ExitProcess(2);CloseHandle(file);ExitProcess(0);
}
