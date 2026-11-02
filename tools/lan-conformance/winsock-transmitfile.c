#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

/* Run the same PE on Windows and BottleShip; record API observations, not expectations. */
__declspec(dllexport) volatile DWORD oracle_results[128];
#ifndef ORACLE_NONCE
#define ORACLE_NONCE 1
#endif
static DWORD count = 3;
static SOCKET apc_tx;
static struct sockaddr_in apc_address;
static WSAOVERLAPPED apc_overlapped;
static volatile DWORD apc_count, apc_error, apc_bytes, apc_flags, apc_same_overlapped, apc_same_thread;
static DWORD apc_owner;
static void CALLBACK receive_complete(DWORD error, DWORD bytes, LPWSAOVERLAPPED overlapped, DWORD flags) {
    apc_error = error; apc_bytes = bytes; apc_flags = flags;
    apc_same_overlapped = overlapped == &apc_overlapped;
    apc_same_thread = GetCurrentThreadId() == apc_owner;
    apc_count++;
}
static DWORD WINAPI delayed_send(LPVOID ignored) {
    (void)ignored;
    Sleep(50);
    sendto(apc_tx, "apc", 3, 0, (struct sockaddr *)&apc_address, sizeof(apc_address));
    return 0;
}
static void record(int value) { oracle_results[count++] = (DWORD)value; }
static void clear_bytes(void *value, DWORD size) {
    unsigned char *p = (unsigned char *)value;
    while (size--) *p++ = 0;
}
static void finish(void) {
    DWORD written;
    HANDLE output;
    oracle_results[0] = 0x42534c4e;
    oracle_results[1] = count;
    output = CreateFileA("lan-oracle.bin", GENERIC_WRITE, 0, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (output != INVALID_HANDLE_VALUE) {
        WriteFile(output, (const void *)oracle_results, count * sizeof(DWORD), &written, 0);
        CloseHandle(output);
    }
    ExitProcess(output == INVALID_HANDLE_VALUE ? 1 : 0);
}

typedef struct TF_BUFFERS { void *Head; DWORD HeadLength; void *Tail; DWORD TailLength; } TF_BUFFERS;
typedef BOOL (WINAPI *transmit_fn)(SOCKET,HANDLE,DWORD,DWORD,LPOVERLAPPED,TF_BUFFERS*,DWORD);
void entry(void) {
    WSADATA data;SOCKET listener,client,server;HANDLE file,event;struct sockaddr_in address;
    int length,r;DWORD written,amount,flags;char buffer[64];TF_BUFFERS extra;OVERLAPPED ov;
    transmit_fn transmit=(transmit_fn)GetProcAddress(LoadLibraryA("wsock32.dll"),"TransmitFile");
    oracle_results[2]=ORACLE_NONCE;record(WSAStartup(MAKEWORD(2,2),&data));record(transmit!=0);
    listener=socket(AF_INET,SOCK_STREAM,6);clear_bytes(&address,sizeof(address));address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    record(bind(listener,(struct sockaddr*)&address,sizeof(address)));record(listen(listener,1));length=sizeof(address);
    getsockname(listener,(struct sockaddr*)&address,&length);client=socket(AF_INET,SOCK_STREAM,6);
    record(connect(client,(struct sockaddr*)&address,sizeof(address)));server=accept(listener,0,0);record(server!=INVALID_SOCKET);
    file=CreateFileA("transmit-file.dat",GENERIC_READ|GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
    record(file!=INVALID_HANDLE_VALUE);WriteFile(file,"0123456789",10,&written,0);record(written);
    record(SetFilePointer(file,3,0,FILE_BEGIN));extra.Head="H";extra.HeadLength=1;extra.Tail="T";extra.TailLength=1;
    WSASetLastError(177);r=transmit(client,file,4,2,0,&extra,0);record(r);record(r?0:WSAGetLastError());
    record(SetFilePointer(file,0,0,FILE_CURRENT));r=recv(server,buffer,6,MSG_WAITALL);record(r);
    record(buffer[0]);record(buffer[1]);record(buffer[4]);record(buffer[5]);
    event=CreateEventA(0,TRUE,FALSE,0);clear_bytes(&ov,sizeof(ov));ov.Offset=1;ov.hEvent=event;
    r=transmit(client,file,3,0,&ov,&extra,0);record(r || WSAGetLastError()==WSA_IO_PENDING);
    record(WaitForSingleObject(event,1000));amount=177;flags=177;r=WSAGetOverlappedResult(client,&ov,&amount,TRUE,&flags);
    record(r);record(r?0:WSAGetLastError());record(amount);record(flags);record(ov.Offset);
    record(SetFilePointer(file,0,0,FILE_CURRENT));r=recv(server,buffer,5,MSG_WAITALL);record(r);record(buffer[0]);record(buffer[1]);record(buffer[3]);record(buffer[4]);
    WSASetLastError(177);r=transmit(client,0,0,0,0,&extra,0);record(r);record(r?0:WSAGetLastError());
    r=recv(server,buffer,2,MSG_WAITALL);record(r);record(buffer[0]);record(buffer[1]);
    CloseHandle(file);CloseHandle(event);closesocket(client);closesocket(server);closesocket(listener);record(WSACleanup());finish();
}
