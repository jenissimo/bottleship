import {DPLAY_MAX_MESSAGE,type DirectPlaySession} from "../session";
import type {DirectPlay4NativeRosterChange} from "./native-session";
import {directPlay4GuestNotification} from "./roster-projection";

/** Delivers already transport-authorized remote changes or player data to
 * local guests. The caller owns session publication and must retire its
 * exact owner on an uncertain outcome. False means the queue was full. */
export class DirectPlay4GuestNotificationOwner {
    private live=true;
    private busy=false;
    constructor(private readonly session:DirectPlaySession,private readonly owns:()=>boolean,
        private readonly onUncertain:(error:Error)=>void) {
        if(!session||typeof owns!=="function"||typeof onUncertain!=="function")
            throw new TypeError("invalid guest notification owner");
    }
    close():void {this.live=false;}
    deliver(playerId:number,change:DirectPlay4NativeRosterChange):boolean {
        return this.submit(playerId,()=>{
            if(change?.playerId===playerId)throw new RangeError("invalid guest recipient");
            const message=directPlay4GuestNotification(change);
            return {valid:()=>true,enqueue:()=>this.session.enqueueSystem(playerId,message)};
        });
    }
    /** Commit a projected remote change and its notification as one guest update. */
    applyRosterChange(playerId:number,change:DirectPlay4NativeRosterChange):boolean {
        return this.applyRosterChanges([playerId],change);
    }
    applyRosterChanges(recipients:readonly number[],change:DirectPlay4NativeRosterChange):boolean {
        const requested=Array.from(recipients),selected=new Set(requested);
        if(selected.size!==requested.length)throw new RangeError("invalid guest recipient");
        // NT5 inserts ordinary players immediately after system players, then
        // distributes system messages by walking that list (newest first).
        const ids=[...this.session.entities.keys()].filter(id=>selected.has(id)).reverse();
        if(ids.length!==requested.length)throw new RangeError("invalid guest recipient");
        return this.submitMany(ids,()=>{
            if(ids.includes(change?.playerId))throw new RangeError("invalid guest recipient");
            const message=directPlay4GuestNotification(change),entity=message.entity!;
            const previous=this.session.entities.get(entity.id);
            return {
                valid:()=>message.type===3 ? !this.session.entities.has(entity.id) :
                    !!previous&&this.session.entities.get(entity.id)===previous&&JSON.stringify(previous)===JSON.stringify(entity),
                validAfter:()=>message.type===3 ? JSON.stringify(this.session.entities.get(entity.id))===JSON.stringify(entity) :
                    !this.session.entities.has(entity.id),
                enqueue:(mayNotify:()=>boolean)=>this.session.enqueueNativeRosterChange(ids,message,mayNotify),
            };
        });
    }
    deliverPlayer(from:number,to:number,data:Uint8Array):boolean {
        return this.submit(to,()=>{
            if(!Number.isInteger(from)||from<1||from>=0xfffffff0||from===to||
                !(data instanceof Uint8Array)||data.length>DPLAY_MAX_MESSAGE)
                throw new RangeError("invalid guest player message");
            // Snapshot before any external owner or event callback can reenter.
            const payload=Uint8Array.from(data),source=this.session.entities.get(from);
            return {
                valid:()=>!!source&&!source.group&&source.owner!==this.session.ownKey&&this.session.entities.get(from)===source,
                enqueue:()=>this.session.enqueueNativePlayer(from,to,payload),
            };
        });
    }
    private submit(playerId:number,prepare:()=>{valid:()=>boolean;validAfter?:()=>boolean;enqueue:(mayNotify:()=>boolean)=>boolean}):boolean {
        return this.submitMany([playerId],prepare);
    }
    private submitMany(ids:readonly number[],prepare:()=>{valid:()=>boolean;validAfter?:()=>boolean;enqueue:(mayNotify:()=>boolean)=>boolean}):boolean {
        if(this.busy)throw new Error("guest delivery operation busy");
        this.busy=true;
        let attempted=false;
        try {
            if(ids.length>128||new Set(ids).size!==ids.length||ids.some(id=>!Number.isInteger(id)||id<1||id>=0xfffffff0))
                throw new RangeError("invalid guest recipient");
            const players=ids.map(id=>this.session.entities.get(id)),description=this.session.desc,prepared=prepare();
            const recipientsCurrent=()=>players.every((player,i)=>!!player&&!player.group&&player.owner===this.session.ownKey&&this.session.entities.get(ids[i])===player);
            const current=(after=false)=>{
                const valid=after?(prepared.validAfter??prepared.valid):prepared.valid;
                if(!this.live||!description||this.session.desc!==description||this.session.openError||!recipientsCurrent()||!valid())return false;
                return !!this.owns()&&this.live&&this.session.desc===description&&
                    !this.session.openError&&recipientsCurrent()&&valid();
            };
            if(!current())throw new Error("guest delivery owner retired");
            attempted=true;
            const queued=prepared.enqueue(()=>current(true));
            // A full queue is a definite refusal, before any mutation.
            if(!queued){attempted=false;return false;}
            if(!current(true))throw new Error("guest delivery owner retired after enqueue");
            return true;
        }catch(error){
            if(attempted){
                this.live=false;
                try{this.onUncertain(error instanceof Error?error:new Error(String(error)));}catch{}
            }
            throw error;
        }finally{this.busy=false;}
    }
}
