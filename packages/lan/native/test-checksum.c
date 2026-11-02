/* Independent full pseudo-header oracle for the native NAT adjustment. */
#define main socket_helper_program_main
#include "socket-helper.c"
#undef main
static unsigned reference(const unsigned char *data,unsigned length,unsigned protocol,int family,const unsigned char *source,const unsigned char *destination){
    unsigned char bytes[128]={0};unsigned size=family==AF_INET?4:16,header=family==AF_INET?12:40;
    memcpy(bytes,source,size);memcpy(bytes+size,destination,size);
    if(family==AF_INET){bytes[9]=(unsigned char)protocol;bytes[10]=(unsigned char)(length>>8);bytes[11]=(unsigned char)length;}
    else{bytes[34]=(unsigned char)(length>>8);bytes[35]=(unsigned char)length;bytes[39]=(unsigned char)protocol;}
    memcpy(bytes+header,data,length);unsigned sum=0;
    for(unsigned index=0;index<header+length;index+=2)sum+=((unsigned)bytes[index]<<8)|(index+1<header+length?bytes[index+1]:0);
    while(sum>>16)sum=(sum&65535)+(sum>>16);
    return (~sum)&65535;
}
int main(void){
    unsigned checks=0;
    { /* canonical vector 1: IPv4 protocol 6 */
        int family=AF_INET;unsigned char source[16]={10,1,2,3},destination[16]={203,0,113,100},native[16]={127,0,0,1};
        unsigned char original[]={3,10,17,24,31,38,45,52,59,66,73,80,87,94,101,108,187,217,129,136,143,150,157,164,171},data[sizeof(original)];memcpy(data,original,sizeof(data));
        if(reference(data,sizeof(data),6,family,source,destination))return 10;
        adjust_transport(data,sizeof(data),6,family,source,destination,native,native);
        if((((unsigned)data[16]<<8)|data[17])!=1600||reference(data,sizeof(data),6,family,native,native))return 11;
        adjust_transport(data,sizeof(data),6,family,native,native,source,destination);
        if(memcmp(data,original,sizeof(data)))return 12;
        data[16]^=128;unsigned invalid=reference(data,sizeof(data),6,family,source,destination);
        adjust_transport(data,sizeof(data),6,family,source,destination,native,native);
        if(!invalid||reference(data,sizeof(data),6,family,native,native)!=invalid)return 13;
        checks+=4;
    }
    { /* canonical vector 2: IPv4 protocol 17 */
        int family=AF_INET;unsigned char source[16]={10,1,2,3},destination[16]={203,0,113,100},native[16]={127,0,0,1};
        unsigned char original[]={3,10,17,24,31,38,168,157,59,66,73,80,87},data[sizeof(original)];memcpy(data,original,sizeof(data));
        if(reference(data,sizeof(data),17,family,source,destination))return 20;
        adjust_transport(data,sizeof(data),17,family,source,destination,native,native);
        if((((unsigned)data[6]<<8)|data[7])!=62211||reference(data,sizeof(data),17,family,native,native))return 21;
        adjust_transport(data,sizeof(data),17,family,native,native,source,destination);
        if(memcmp(data,original,sizeof(data)))return 22;
        data[6]^=128;unsigned invalid=reference(data,sizeof(data),17,family,source,destination);
        adjust_transport(data,sizeof(data),17,family,source,destination,native,native);
        if(!invalid||reference(data,sizeof(data),17,family,native,native)!=invalid)return 23;
        checks+=4;
    }
    { /* canonical vector 3: IPv6 protocol 6 */
        int family=AF_INET6;unsigned char source[16]={253,66,98,115,108,97,110,0,0,0,2,0,0,7,7,1},destination[16]={32,1,13,184,0,0,0,0,0,0,0,0,0,0,0,100},native[16]={0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
        unsigned char original[]={3,10,17,24,31,38,45,52,59,66,73,80,87,94,101,108,147,5,129,136,143,150,157,164,171},data[sizeof(original)];memcpy(data,original,sizeof(data));
        if(reference(data,sizeof(data),6,family,source,destination))return 30;
        adjust_transport(data,sizeof(data),6,family,source,destination,native,native);
        if((((unsigned)data[16]<<8)|data[17])!=1089||reference(data,sizeof(data),6,family,native,native))return 31;
        adjust_transport(data,sizeof(data),6,family,native,native,source,destination);
        if(memcmp(data,original,sizeof(data)))return 32;
        data[16]^=128;unsigned invalid=reference(data,sizeof(data),6,family,source,destination);
        adjust_transport(data,sizeof(data),6,family,source,destination,native,native);
        if(!invalid||reference(data,sizeof(data),6,family,native,native)!=invalid)return 33;
        checks+=4;
    }
    { /* canonical vector 4: IPv6 protocol 17 */
        int family=AF_INET6;unsigned char source[16]={253,66,98,115,108,97,110,0,0,0,2,0,0,7,7,1},destination[16]={32,1,13,184,0,0,0,0,0,0,0,0,0,0,0,100},native[16]={0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
        unsigned char original[]={3,10,17,24,31,38,127,201,59,66,73,80,87},data[sizeof(original)];memcpy(data,original,sizeof(data));
        if(reference(data,sizeof(data),17,family,source,destination))return 40;
        adjust_transport(data,sizeof(data),17,family,source,destination,native,native);
        if((((unsigned)data[6]<<8)|data[7])!=61700||reference(data,sizeof(data),17,family,native,native))return 41;
        adjust_transport(data,sizeof(data),17,family,native,native,source,destination);
        if(memcmp(data,original,sizeof(data)))return 42;
        data[6]^=128;unsigned invalid=reference(data,sizeof(data),17,family,source,destination);
        adjust_transport(data,sizeof(data),17,family,source,destination,native,native);
        if(!invalid||reference(data,sizeof(data),17,family,native,native)!=invalid)return 43;
        checks+=4;
    }
    { /* canonical vector 5: IPv6 protocol 58 */
        int family=AF_INET6;unsigned char source[16]={253,66,98,115,108,97,110,0,0,0,2,0,0,7,7,1},destination[16]={32,1,13,184,0,0,0,0,0,0,0,0,0,0,0,100},native[16]={0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
        unsigned char original[]={3,10,99,132,31,38,45,52,59,66,73,80,87},data[sizeof(original)];memcpy(data,original,sizeof(data));
        if(reference(data,sizeof(data),58,family,source,destination))return 50;
        adjust_transport(data,sizeof(data),58,family,source,destination,native,native);
        if((((unsigned)data[2]<<8)|data[3])!=54463||reference(data,sizeof(data),58,family,native,native))return 51;
        adjust_transport(data,sizeof(data),58,family,native,native,source,destination);
        if(memcmp(data,original,sizeof(data)))return 52;
        data[2]^=128;unsigned invalid=reference(data,sizeof(data),58,family,source,destination);
        adjust_transport(data,sizeof(data),58,family,source,destination,native,native);
        if(!invalid||reference(data,sizeof(data),58,family,native,native)!=invalid)return 53;
        checks+=4;
    }
    {unsigned char data[8]={1,2,3,4,0,8,0,0},old[4]={10,1,2,3},next[4]={127,0,0,1};
     adjust_transport(data,8,17,AF_INET,old,old,next,next);if(data[6]||data[7])return 90;checks++;}
    printf("{\"checks\":%u}\n",checks);return 0;
}
