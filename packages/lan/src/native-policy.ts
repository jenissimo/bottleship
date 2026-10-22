/** Generic RAW capture has no browser-room boundary. Protocols without tuple
 * NAT use an exclusive destination lease that blocks foreign flows to that IP. */
export class NativeDestinationPolicy {
    private readonly destinations=new Map<string,Map<object,{shared:number;exclusive:number}>>();
    acquire(destination:string,owner:object,exclusive:boolean):(()=>void)|null {
        let owners=this.destinations.get(destination);
        if(owners)for(const [other,counts] of owners)if(other!==owner&&(exclusive||counts.exclusive))return null;
        if(!owners)this.destinations.set(destination,owners=new Map());
        let counts=owners.get(owner);if(!counts)owners.set(owner,counts={shared:0,exclusive:0});
        if(exclusive)counts.exclusive++;else counts.shared++;
        let released=false;
        return ()=>{
            if(released)return;released=true;
            if(exclusive)counts!.exclusive--;else counts!.shared--;
            if(!counts!.shared&&!counts!.exclusive)owners!.delete(owner);
            if(!owners!.size)this.destinations.delete(destination);
        };
    }
}
