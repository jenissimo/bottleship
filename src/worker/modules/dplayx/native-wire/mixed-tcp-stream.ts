import {decodeDirectPlay4SystemTcpFrame,type DirectPlay4SystemTcpFrame} from "./tcp-frame";
import {decodeDirectPlay4PlayerTcpFrame,type DirectPlay4PlayerTcpFrame} from "./player-tcp";
import {decodeDirectPlay4PlayerWrapper} from "./player-wrapper";

/** Normal provider TOKEN and nonsecure player IDs, including PLAYERWRAPPER.
 * Secure messages, NOMESSAGEID and control tokens need their own handlers.
 * Bounds are local safety policy. */
export type DirectPlay4MixedTcpFrame =
    | {kind:"system";frame:DirectPlay4SystemTcpFrame}
    | {kind:"player";frame:DirectPlay4PlayerTcpFrame};
export class DirectPlay4MixedTcpStream {
    private readonly buffer:Uint8Array;private used=0;private expected=0;private terminal=false;
    constructor(private readonly maxFrameBytes:number,private readonly maxFramesPerPush:number,private readonly maxBatchBytes:number){
        if(!Number.isInteger(maxFrameBytes)||maxFrameBytes<28||maxFrameBytes>0xfffff||
            !Number.isInteger(maxFramesPerPush)||maxFramesPerPush<1||maxFramesPerPush>4096||
            !Number.isInteger(maxBatchBytes)||maxBatchBytes<maxFrameBytes||maxBatchBytes>0x1000000)
            throw new RangeError("invalid mixed stream limits");
        this.buffer=new Uint8Array(maxFrameBytes);
    }
    push(chunk:Uint8Array):DirectPlay4MixedTcpFrame[]{
        if(this.terminal)throw new Error("mixed stream closed");
        const result:DirectPlay4MixedTcpFrame[]=[];let offset=0,bytes=0;
        try{
            if(!(chunk instanceof Uint8Array))throw new TypeError("chunk must be bytes");
            while(offset<chunk.length){
                const target=this.expected||4,count=Math.min(target-this.used,chunk.length-offset);
                this.buffer.set(chunk.subarray(offset,offset+count),this.used);offset+=count;this.used+=count;
                if(!this.expected&&this.used===4){
                    const token=new DataView(this.buffer.buffer).getUint32(0,true),size=token&0xfffff;
                    if(((token&0xfff00000)>>>0)!==0xfab00000||size<28||size>this.maxFrameBytes)
                        throw new RangeError("invalid mixed frame header");
                    this.expected=size;
                }
                if(this.expected&&this.used===this.expected){
                    if(result.length>=this.maxFramesPerPush||this.used>this.maxBatchBytes-bytes)throw new RangeError("mixed frame batch limit");
                    bytes+=this.used;
                    const bytesView=this.buffer.subarray(0,this.used);
                    const isSystem=new DataView(this.buffer.buffer).getUint32(20,true)===0x79616c70;
                    if(isSystem){
                        const frame=decodeDirectPlay4SystemTcpFrame(bytesView,this.maxFrameBytes);
                        if(!frame)throw new Error("incomplete system frame");
                        if(frame.command===25){
                            const player=decodeDirectPlay4PlayerWrapper(bytesView,this.maxFrameBytes);
                            if(!player)throw new Error("incomplete player wrapper");result.push({kind:"player",frame:player});
                        }else result.push({kind:"system",frame});
                    }else{
                        const frame=decodeDirectPlay4PlayerTcpFrame(bytesView,this.maxFrameBytes);
                        if(!frame)throw new Error("incomplete player frame");result.push({kind:"player",frame});
                    }
                    this.used=0;this.expected=0;
                }
            }
            return result;
        }catch(error){this.terminal=true;this.used=0;this.expected=0;throw error;}
    }
    finish():void{
        if(this.terminal)throw new Error("mixed stream closed");
        this.terminal=true;if(this.used){this.used=0;this.expected=0;throw new RangeError("truncated mixed frame");}
    }
}
