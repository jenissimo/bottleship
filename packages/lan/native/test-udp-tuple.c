/* Production UDP tuple translation, independent checksum oracle, actual OS port
 * reservations and datagram delivery. This requires no raw-socket privileges. */
#define main socket_helper_program_main
#include "socket-helper.c"
#undef main
#ifdef _WIN32
typedef int test_socklen_t;
#else
typedef socklen_t test_socklen_t;
#endif
static unsigned checks;
#define VERIFY(expression) do { if(!(expression)){fprintf(stderr,"UDP tuple check failed at line %d\n",__LINE__);goto fail;} checks++; } while(0)
static unsigned full_checksum(const unsigned char *udp,unsigned length,int family,const unsigned char *source,const unsigned char *destination){
    unsigned char bytes[128]={0};unsigned size=family==AF_INET?4:16,prefix=family==AF_INET?12:40;
    memcpy(bytes,source,size);memcpy(bytes+size,destination,size);
    if(family==AF_INET){bytes[9]=17;bytes[10]=(unsigned char)(length>>8);bytes[11]=(unsigned char)length;}
    else{bytes[34]=(unsigned char)(length>>8);bytes[35]=(unsigned char)length;bytes[39]=17;}
    memcpy(bytes+prefix,udp,length);unsigned sum=0;
    for(unsigned index=0;index<prefix+length;index+=2)sum+=((unsigned)bytes[index]<<8)|(index+1<prefix+length?bytes[index+1]:0);
    while(sum>>16)sum=(sum&65535)+(sum>>16);
    return (~sum)&65535;
}
static void udp_packet(unsigned char *udp,unsigned source_port,unsigned destination_port,int family,const unsigned char *source,const unsigned char *destination,unsigned tag){
    memset(udp,0,12);udp[0]=(unsigned char)(source_port>>8);udp[1]=(unsigned char)source_port;
    udp[2]=(unsigned char)(destination_port>>8);udp[3]=(unsigned char)destination_port;udp[5]=12;
    udp[8]=0x41;udp[9]=(unsigned char)tag;udp[10]=0x57;udp[11]=0x92;
    unsigned checksum=full_checksum(udp,12,family,source,destination);if(!checksum)checksum=65535;
    udp[6]=(unsigned char)(checksum>>8);udp[7]=(unsigned char)checksum;
}
static int receive_packet(socket_t descriptor,unsigned char *data,unsigned length,struct sockaddr_storage *source){
    fd_set reads;FD_ZERO(&reads);FD_SET(descriptor,&reads);struct timeval timeout={2,0};
    if(select((int)descriptor+1,&reads,NULL,NULL,&timeout)!=1)return -1;
    test_socklen_t size=sizeof(*source);
    return recvfrom(descriptor,(char*)data,(int)length,0,(struct sockaddr*)source,&size);
}
static unsigned get_port(const struct sockaddr_storage *address){return ntohs(address->ss_family==AF_INET?((const struct sockaddr_in*)address)->sin_port:((const struct sockaddr_in6*)address)->sin6_port);}
static int family_checks(int family){
    socket_t peer=INVALID_SOCKET,candidate=INVALID_SOCKET;
    udp_tuple_t tuples[2]={{INVALID_SOCKET,0,0,0,0},{INVALID_SOCKET,0,0,0,0}};
    struct sockaddr_storage local,remote,observed;memset(&local,0,sizeof(local));
    local.ss_family=(unsigned short)family;
    unsigned char native[16]={0},guest[16]={0},advertised[16]={0};
    if(family==AF_INET){native[0]=127;native[3]=1;guest[0]=10;guest[1]=1;guest[2]=2;guest[3]=3;advertised[0]=203;advertised[2]=113;advertised[3]=202;memcpy(&((struct sockaddr_in*)&local)->sin_addr,native,4);}
    else{native[15]=1;guest[0]=253;guest[1]=66;guest[15]=3;advertised[0]=32;advertised[1]=1;advertised[2]=13;advertised[3]=184;advertised[15]=202;memcpy(&((struct sockaddr_in6*)&local)->sin6_addr,native,16);}
    remote=local;test_socklen_t size=family==AF_INET?sizeof(struct sockaddr_in):sizeof(struct sockaddr_in6);
    peer=socket(family,SOCK_DGRAM,IPPROTO_UDP);VERIFY(peer!=INVALID_SOCKET);
    VERIFY(bind(peer,(struct sockaddr*)&remote,size)==0);
    VERIFY(getsockname(peer,(struct sockaddr*)&remote,&size)==0);
    unsigned peer_port=get_port(&remote),guest_port=41011;
    VERIFY(udp_tuple_open(&tuples[0],family,&local,guest_port,peer_port)==0);
    VERIFY(udp_tuple_open(&tuples[1],family,&local,guest_port,peer_port)==0);
    VERIFY(tuples[0].native!=tuples[1].native);
    candidate=socket(family,SOCK_DGRAM,IPPROTO_UDP);VERIFY(candidate!=INVALID_SOCKET);
    struct sockaddr_storage occupied=local;
    if(family==AF_INET)((struct sockaddr_in*)&occupied)->sin_port=htons((unsigned short)tuples[0].native);
    else ((struct sockaddr_in6*)&occupied)->sin6_port=htons((unsigned short)tuples[0].native);
    VERIFY(bind(candidate,(struct sockaddr*)&occupied,size)==SOCKET_ERROR);
    CLOSESOCKET(candidate);candidate=INVALID_SOCKET;
    for(unsigned room=0;room<2;room++){
        unsigned char original[12],outgoing[12],invalid[12],data[64],reply[12],foreign[12];
        udp_packet(original,guest_port,peer_port,family,guest,advertised,room);
        memcpy(outgoing,original,12);
        VERIFY(udp_tuple_translate(&tuples[room],family,0,outgoing,12,1)==0);
        adjust_transport(outgoing,12,17,family,guest,advertised,native,native);
        VERIFY((((unsigned)outgoing[0]<<8)|outgoing[1])==tuples[room].native&&full_checksum(outgoing,12,family,native,native)==0);
        memcpy(invalid,original,12);invalid[6]^=128;unsigned residual=full_checksum(invalid,12,family,guest,advertised);
        VERIFY(residual!=0&&udp_tuple_translate(&tuples[room],family,0,invalid,12,1)==0);
        adjust_transport(invalid,12,17,family,guest,advertised,native,native);
        VERIFY(full_checksum(invalid,12,family,native,native)==residual);
        VERIFY(sendto(tuples[room].reservation,(const char*)outgoing+8,4,0,(struct sockaddr*)&remote,size)==4);
        VERIFY(receive_packet(peer,data,sizeof(data),&observed)==4&&data[1]==room&&get_port(&observed)==tuples[room].native);
        VERIFY(sendto(peer,(const char*)data,4,0,(struct sockaddr*)&observed,size)==4);
        struct sockaddr_storage received_from;
        VERIFY(receive_packet(tuples[room].reservation,data,sizeof(data),&received_from)==4&&data[1]==room&&get_port(&received_from)==peer_port);
        udp_packet(reply,get_port(&received_from),get_port(&observed),family,native,native,room);
        memcpy(foreign,reply,12);
        VERIFY(udp_tuple_translate(&tuples[1-room],family,0,foreign,12,0)==-1&&memcmp(foreign,reply,12)==0);
        foreign[0]^=1;
        VERIFY(udp_tuple_translate(&tuples[room],family,0,foreign,12,0)==-1);
        VERIFY(udp_tuple_translate(&tuples[room],family,0,reply,12,0)==0);
        adjust_transport(reply,12,17,family,native,native,advertised,guest);
        VERIFY((((unsigned)reply[2]<<8)|reply[3])==guest_port&&full_checksum(reply,12,family,advertised,guest)==0);
        if(family==AF_INET){
            memcpy(outgoing,original,12);outgoing[6]=outgoing[7]=0;
            VERIFY(udp_tuple_translate(&tuples[room],family,0,outgoing,12,1)==0&&outgoing[6]==0&&outgoing[7]==0);
        }
    }
    {unsigned char fragment[52]={0};unsigned offset=family==AF_INET?20:40;
     fragment[0]=(unsigned char)(family==AF_INET?0x45:0x60);fragment[family==AF_INET?9:6]=17;
     udp_packet(fragment+offset,guest_port,peer_port,family,guest,advertised,1);
     VERIFY(udp_tuple_translate(&tuples[0],family,1,fragment,offset+12,1)==0);
     if(family==AF_INET)fragment[6]=0x20;else fragment[6]=44;
     VERIFY(udp_tuple_translate(&tuples[0],family,1,fragment,offset+12,1)==10045);
    }
    udp_tuple_close(&tuples[0]);
    candidate=socket(family,SOCK_DGRAM,IPPROTO_UDP);VERIFY(candidate!=INVALID_SOCKET);
    VERIFY(bind(candidate,(struct sockaddr*)&occupied,size)==0); // Actual kernel port is reusable after teardown.
    CLOSESOCKET(candidate);udp_tuple_close(&tuples[1]);CLOSESOCKET(peer);return 0;
fail:
    if(candidate!=INVALID_SOCKET)CLOSESOCKET(candidate);
    udp_tuple_close(&tuples[0]);udp_tuple_close(&tuples[1]);if(peer!=INVALID_SOCKET)CLOSESOCKET(peer);return 1;
}
int main(void){
#ifdef _WIN32
    WSADATA data;if(WSAStartup(MAKEWORD(2,2),&data))return 2;
#endif
    if(family_checks(AF_INET)||family_checks(AF_INET6))return 1;
    printf("{\"checks\":%u,\"families\":2}\n",checks);return 0;
}
