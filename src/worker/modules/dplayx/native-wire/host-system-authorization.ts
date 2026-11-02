import type {DirectPlay4OwnedNameTable} from "./join-name-table-owner";

/** Restrict a native Join owner to the one host system represented by the
 * observed normal version-14 name table. The caller must independently bind
 * the actual transport peer to the discovered host and keep the owner live. */
export function directPlay4HostSystemMatches(table:DirectPlay4OwnedNameTable,systemPlayerId:number):boolean {
    if(!table||table.version!==14||!Number.isInteger(systemPlayerId)||systemPlayerId<1||systemPlayerId>=0xfffffff0)
        return false;
    // In the observed host-only snapshot all host-owned application players
    // can carry flags 12, so no individual application player identifies the
    // host. Restrict this policy to exactly one remote system, with the
    // observed nameserver-system flags and at least one owned normal player.
    const systems=table.players.filter(p=>(p.flags&1)!==0&&!p.preexisting);
    if(systems.length!==1||systems[0].id!==systemPlayerId||systems[0].flags!==15)return false;
    const players=table.players.filter(p=>!(p.flags&1));
    return players.length>0&&players.every(p=>(p.flags===8||p.flags===12)&&p.versionOrSystemId===systemPlayerId);
}
