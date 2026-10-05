// Native x86-64 oracle for REP data/flag semantics. No timing or OS emulation.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
static unsigned char left[8192], right[8192];
#define RUN(insn) __asm__ volatile ("pushq %[initial]\n\tpopfq\n\t" insn "\n\tpushfq\n\tpopq %[result]\n\tcld" \
    : [result] "=&r" (result), "+S" (src), "+D" (dst), "+c" (remaining) \
    : "a" (value), [initial] "r" (initial) : "memory", "cc")
int main(void) {
    unsigned op, size, eq, backwards, count, value, flags, offset; int stop;
    while (scanf("%u %u %u %u %u %u %u %d %u", &op,&size,&eq,&backwards,&count,&value,&flags,&stop,&offset)==9) {
        if(op>2||(size!=1&&size!=2&&size!=4)||count>1024||offset>16)return 2;
        memset(left,173,sizeof left); memset(right,173,sizeof right);
        for(unsigned i=0;i<count;i++) {
            uint32_t a=value,b;
            unsigned index=backwards?count-1-i:i;
            b=((int)index==stop)?(eq?a^0x81:a):(eq?a:a^0x81);
            memcpy(left+16+offset+i*size,&a,size);memcpy(right+16+offset+i*size,&b,size);
        }
        unsigned start=16+offset+(backwards&&count?(count-1)*size:0);
        unsigned char *src=left+start,*dst=right+start;
        uint64_t remaining=count,initial=(flags&~0x400u)|(backwards?0x400u:0),result;
        if(op==0) {
            if(eq) { if(size==1){RUN("repe cmpsb");}else if(size==2){RUN("repe cmpsw");}else{RUN("repe cmpsl");} }
            else { if(size==1){RUN("repne cmpsb");}else if(size==2){RUN("repne cmpsw");}else{RUN("repne cmpsl");} }
        } else if(op==1) {
            if(eq) { if(size==1){RUN("repe scasb");}else if(size==2){RUN("repe scasw");}else{RUN("repe scasl");} }
            else { if(size==1){RUN("repne scasb");}else if(size==2){RUN("repne scasw");}else{RUN("repne scasl");} }
        } else { if(size==1){RUN("rep stosb");}else if(size==2){RUN("rep stosw");}else{RUN("rep stosl");} }
        uint32_t hash=2166136261u;
        for(unsigned i=0;i<count*size;i++)hash=(hash^right[16+offset+i])*16777619u;
        printf("%" PRIu64 " %td %td %" PRIu64 " %" PRIu32 "\n",remaining,src-left-16,dst-right-16,result&0xcd5u,hash);
    }
    return ferror(stdin)?1:0;
}
