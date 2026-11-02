import { NativeRawSocket } from "./native-raw";
/** Native datagram adapter preserving IPv6 zones through the OS resolver. */
export class NativeUdpSocket {
    private readonly native: NativeRawSocket;
    constructor(executable: string, private readonly family: 4 | 6) { this.native=new NativeRawSocket(executable); }
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "message", listener: (bytes: Uint8Array) => void): this;
    on(event: string, listener: (...args: any[]) => void): this { this.native.on(event,listener); return this; }
    connect(port: number, host: string, callback: (error?: Error) => void): void {
        this.native.once("connect",()=>callback());this.native.connectUdp(host,this.family,port);
    }
    send(bytes: Uint8Array, callback: (error?: Error|null) => void): void {
        let completed=false;
        const complete=(error?:Error|null)=>{if(!completed){completed=true;callback(error);}};
        if(!this.native.send(bytes,complete))complete(Object.assign(new Error("Native UDP write queue full"),{code:10055}));
    }
    close(): void { this.native.close(); }
}
