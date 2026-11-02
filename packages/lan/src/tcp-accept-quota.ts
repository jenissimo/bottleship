import {TcpHostCapacity} from "./tcp-host-owner";

/** The helper channel must report false only when no grant bytes were admitted.
 * An exception leaves the outcome unknown and pins the permit until process exit. */
export interface TcpAcceptDemand {
    owner:object;
    epoch:number;
    grant(token:bigint):boolean;
    fatal(error:unknown):void;
}
type Active={owner:object;epoch:number;release:()=>void};
type Queued=TcpAcceptDemand & {queued:boolean};

/** Bounded FIFO arbiter. Never acquire a permit while no listener asks for one.
 * Capacity releases wake queued demands, including releases by other users.
 * processClosed() is legal only after the exact owned helper process has exited. */
export class TcpAcceptQuota {
    private serial=0n;
    private readonly active=new Map<bigint,Active>();
    private readonly pending:Queued[]=[];
    private pumping=false;
    private disposed=false;
    private readonly unsubscribe:()=>void;
    constructor(private readonly capacity:TcpHostCapacity,private readonly maxPending=128) {
        if(!Number.isInteger(maxPending)||maxPending<1||maxPending>4096)throw new RangeError("Invalid accept demand bound");
        this.unsubscribe=capacity.onRelease(()=>this.wake());
    }
    get activeCount():number{return this.active.size;}
    get pendingCount():number{return this.pending.length;}
    demand(request:TcpAcceptDemand):(()=>void)|null {
        if(this.disposed)throw new Error("Accept quota disposed");
        if(!request||!request.owner||!Number.isInteger(request.epoch)||request.epoch<1||request.epoch>0xffffffff||
            typeof request.grant!=="function"||typeof request.fatal!=="function")throw new TypeError("Invalid accept demand");
        if(this.pending.length>=this.maxPending||this.pending.some(item=>item.owner===request.owner&&item.epoch===request.epoch))
            return null;
        const entry:Queued={...request,queued:true};
        this.pending.push(entry);this.wake();
        return ()=>{
            if(!entry.queued)return;
            entry.queued=false;
            const index=this.pending.indexOf(entry);if(index>=0)this.pending.splice(index,1);
        };
    }
    wake():void {
        if(this.disposed||this.pumping)return;
        this.pumping=true;
        try {
            while(this.pending.length) {
                if(this.serial===0xffffffffffffffffn) {
                    const failed=this.pending.shift()!;failed.queued=false;
                    try{failed.fatal(new Error("Accept permit identity exhausted"));}catch{}
                    continue;
                }
                const release=this.capacity.acquire();if(!release)break;
                const request=this.pending.shift()!;request.queued=false;
                const token=++this.serial;
                this.active.set(token,{owner:request.owner,epoch:request.epoch,release});
                try {
                    if(!request.grant(token))this.complete(request.owner,request.epoch,token);
                } catch(error) {
                    // The IPC write may already have been accepted: do not free.
                    try{request.fatal(error);}catch{}
                }
            }
        } finally {this.pumping=false;}
    }
    /** Unsubscribe only after all physical ownership and queued demand ends. */
    dispose():void {
        if(this.active.size||this.pending.length)throw new Error("Accept quota still owns demand");
        if(!this.disposed){this.disposed=true;this.unsubscribe();}
    }
    /** Exact helper confirmation that this token was unused or the socket closed. */
    complete(owner:object,epoch:number,token:bigint):boolean {
        const item=this.active.get(token);
        if(!item||item.owner!==owner||item.epoch!==epoch)return false;
        this.active.delete(token);item.release();this.wake();return true;
    }
    /** Retire queued requests immediately; active tokens survive until exit. */
    cancelOwner(owner:object,epoch:number):void {
        for(let i=this.pending.length-1;i>=0;i--)if(this.pending[i].owner===owner&&this.pending[i].epoch===epoch) {
            this.pending[i].queued=false;this.pending.splice(i,1);
        }
    }
    processClosed(owner:object,epoch:number):void {
        this.cancelOwner(owner,epoch);
        for(const [token,item] of this.active)if(item.owner===owner&&item.epoch===epoch) {
            this.active.delete(token);item.release();
        }
        this.wake();
    }
}
