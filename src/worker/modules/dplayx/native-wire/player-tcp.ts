/**
 * Isolated normal-token TCP framing for nonsecure player messages with IDs.
 * NT5 dplay/dpmess.h:309-313, sysmess.c:1573-1611,1713-1766 and
 * wsock/dpsp.h:94-128. Does not implement NOMESSAGEID, PLAYERWRAPPER,
 * other provider tokens, peer authorization, routing, or a live session.
 * Limits and rejecting the ambiguous 'play' ID are local safety policy.
 */
export interface DirectPlay4PlayerTcpFrame {
    consumed:number; providerSockaddr:Uint8Array; from:number; to:number; data:Uint8Array;
}
const validLimit=(n:number)=>Number.isInteger(n)&&n>=28&&n<=0xfffff;
const uint=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
const magic=0x79616c70;
export function encodeDirectPlay4PlayerTcpFrame(provider:Uint8Array,from:number,to:number,data:Uint8Array,maxBytes:number):Uint8Array {
    if(!validLimit(maxBytes))throw new RangeError("invalid frame limit");
    if(!(provider instanceof Uint8Array)||provider.length!==16||!(data instanceof Uint8Array)||
        !uint(from)||!uint(to)||from===magic)throw new RangeError("unsupported player frame");
    const size=28+data.length;if(size>maxBytes)throw new RangeError("player frame exceeds limit");
    const b=new Uint8Array(size),v=new DataView(b.buffer);
    v.setUint32(0,(0xfab00000|size)>>>0,true);b.set(provider,4);
    v.setUint32(20,from,true);v.setUint32(24,to,true);b.set(data,28);return b;
}
export function decodeDirectPlay4PlayerTcpFrame(input:Uint8Array,maxBytes:number):DirectPlay4PlayerTcpFrame|null {
    if(!validLimit(maxBytes))throw new RangeError("invalid frame limit");
    if(!(input instanceof Uint8Array))throw new TypeError("input must be bytes");
    if(input.length<4)return null;
    const v=new DataView(input.buffer,input.byteOffset,input.byteLength),token=v.getUint32(0,true),size=token&0xfffff;
    if(((token&0xfff00000)>>>0)!==0xfab00000||size<28||size>maxBytes)throw new RangeError("invalid player frame");
    if(input.length<size)return null;
    const from=v.getUint32(20,true);
    if(from===magic)throw new RangeError("system/wrapped message is not raw player data");
    return {consumed:size,providerSockaddr:Uint8Array.from(input.subarray(4,20)),from,to:v.getUint32(24,true),
        data:Uint8Array.from(input.subarray(28,size))};
}
/** Separate player-only reader. Mixed system/player demux and ACL remain the
 * responsibility of a future session owner. Failed batches are terminal. */
export class DirectPlay4PlayerTcpStream {
    private readonly buffer:Uint8Array;private used=0;private expected=0;private terminal=false;
    constructor(private readonly maxFrameBytes:number,private readonly maxFramesPerPush:number,private readonly maxBatchBytes:number){
        if(!validLimit(maxFrameBytes)||!Number.isInteger(maxFramesPerPush)||maxFramesPerPush<1||maxFramesPerPush>4096||
            !Number.isInteger(maxBatchBytes)||maxBatchBytes<maxFrameBytes||maxBatchBytes>0x1000000)
            throw new RangeError("invalid stream limits");
        this.buffer=new Uint8Array(maxFrameBytes);
    }
    push(chunk:Uint8Array):DirectPlay4PlayerTcpFrame[]{
        if(this.terminal)throw new Error("player stream closed");
        const result:DirectPlay4PlayerTcpFrame[]=[];let offset=0,bytes=0;
        try{
            if(!(chunk instanceof Uint8Array))throw new TypeError("chunk must be bytes");
            while(offset<chunk.length){
                const target=this.expected||4,count=Math.min(target-this.used,chunk.length-offset);
                this.buffer.set(chunk.subarray(offset,offset+count),this.used);offset+=count;this.used+=count;
                if(!this.expected&&this.used===4){
                    const token=new DataView(this.buffer.buffer).getUint32(0,true),size=token&0xfffff;
                    if(((token&0xfff00000)>>>0)!==0xfab00000||size<28||size>this.maxFrameBytes)
                        throw new RangeError("invalid player frame header");
                    this.expected=size;
                }
                if(this.expected&&this.used===this.expected){
                    if(result.length>=this.maxFramesPerPush||this.used>this.maxBatchBytes-bytes)throw new RangeError("player frame batch limit");
                    bytes+=this.used;
                    const frame=decodeDirectPlay4PlayerTcpFrame(this.buffer.subarray(0,this.used),this.maxFrameBytes);
                    if(!frame)throw new Error("incomplete player frame");
                    result.push(frame);this.used=0;this.expected=0;
                }
            }
            return result;
        }catch(error){this.terminal=true;this.used=0;this.expected=0;throw error;}
    }
    finish():void{
        if(this.terminal)throw new Error("player stream closed");
        this.terminal=true;
        if(this.used){this.used=0;this.expected=0;throw new RangeError("truncated player frame");}
    }
}
