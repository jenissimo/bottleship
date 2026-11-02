import type { Entity } from "../../dplayx/session";
import { DPN } from "../constants";

export type GroupState = "live" | "disconnecting" | "deleted" | "missing";
export type MemberHook = (group: number, player: number, add: boolean, returned: (result?: number) => void) => void;
export type DestroyHook = (group: number, returned: (result?: number) => void) => void;
export interface Pair {
    readonly group: number; readonly player: number; readonly generation: number;
    version: number; linked: boolean; available: boolean; pendingAdd: boolean; pendingRemove: boolean; referencesOwned: boolean;
}
interface Entry {
    entity: Entity; created: boolean; state: Exclude<GroupState, "missing">; base: boolean; refs: number; retired: boolean;
    needDestroy: boolean; notifying: boolean; notified: boolean; destroyHook?: DestroyHook;
}
const key = (group: number, player: number) => group + ":" + player;
const u32 = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

/**
 * NT5 normal Created-pair linkage and notification ownership. Caller owns public
 * table/version/wire. NeedToAdd/initial-CREATE races remain an explicit open slice.
 * These finite entry/pair/pending bounds are local resource policy, not native quotas.
 */
export class NativeGroupMemberships {
    private entries = new Map<number, Entry>();
    private linked = new Map<string, Pair>();
    private records = new Set<Pair>();
    private notifying = new Set<Pair>();
    private pending = new Set<(result: number) => void>();
    private generation = 0;
    private clearing = false;
    track(entity: Entity, created = true): number {
        if (this.clearing) return DPN.ALREADYCLOSING;
        const row = this.entries.get(entity.id);
        if (row) {
            if (row.entity.group !== entity.group || row.retired) return DPN.INVALIDPARAM;
            if (row.state === "live") { row.entity = entity; if (entity.group) entity.members = this.members(entity.id); }
            row.created ||= created;
            return DPN.OK;
        }
        if (this.entries.size >= 4096) return DPN.TABLEFULL;
        this.entries.set(entity.id, { entity, created, state: "live", base: true, refs: 0, retired: false,
            needDestroy: false, notifying: false, notified: false });
        return DPN.OK;
    }
    created(id: number): void { const row = this.entries.get(id); if (row && !row.retired) row.created = true; }
    queryGroup(id: number): Entity | undefined {
        const row = this.entries.get(id);
        return row?.entity.group && !row.retired && !row.notified ? row.entity : undefined;
    }
    groupState(id: number): GroupState {
        const row = this.entries.get(id); return row?.entity.group && !row.retired ? row.state : "missing";
    }
    references(id: number): number { return this.entries.get(id)?.refs ?? 0; }
    members(group: number): number[] { return [...this.linked.values()].filter(p => p.group === group).map(p => p.player); }
    snapshot(): { group: number; player: number; version: number; unused: 0 }[] {
        return [...this.linked.values()].map(p => ({ group: p.group, player: p.player, version: p.version, unused: 0 }));
    }
    private pair(group: number, player: number, version: number, stable: boolean): Pair | number {
        const g = this.entries.get(group), p = this.entries.get(player);
        if (!g?.entity.group || g.retired) return DPN.INVALIDGROUP;
        if (!p || p.entity.group || p.retired) return DPN.INVALIDPLAYER;
        if (!u32(version)) return DPN.INVALIDPARAM;
        if (g.state !== "live" || p.state !== "live" || (!stable && (!g.created || !p.created))) return DPN.UNSUPPORTED;
        if (this.linked.has(key(group, player))) return DPN.PLAYERALREADYINGROUP;
        if (this.records.size >= 4096 || this.pending.size >= 512) return DPN.TABLEFULL;
        const pair: Pair = { group, player, generation: this.generation, version, linked: true, available: stable,
            pendingAdd: !stable, pendingRemove: false, referencesOwned: true };
        this.linked.set(key(group, player), pair); this.records.add(pair); g.refs++; p.refs++;
        return pair;
    }
    seed(group: number, player: number, version: number): number {
        const old = this.linked.get(key(group, player));
        if (old && old.version === version && old.available && !old.pendingAdd && !old.pendingRemove) return DPN.OK;
        const result = this.pair(group, player, version, true); return typeof result === "number" ? result : DPN.OK;
    }
    beginAdd(group: number, player: number, version: number): Pair | number { return this.pair(group, player, version, false); }
    beginRemove(group: number, player: number, version: number | null): Pair | number {
        const pair = this.linked.get(key(group, player));
        if (!pair || !pair.linked || pair.pendingRemove) return DPN.PLAYERNOTINGROUP;
        // The historical NeedToAdd/NeedToRemove race is not repaired or claimed here.
        if (pair.pendingAdd || !pair.available) return DPN.UNSUPPORTED;
        if (version !== null && !u32(version)) return DPN.INVALIDPARAM;
        if (this.pending.size >= 512) return DPN.TABLEFULL;
        this.linked.delete(key(group, player)); pair.linked = false; pair.available = false; pair.pendingRemove = true;
        if (version !== null) pair.version = version;
        return pair;
    }
    private completion(done: (result: number) => void): (result: number) => void {
        let finished = false;
        const finish = (result: number) => {
            if (finished) return; finished = true; this.pending.delete(finish); done(result);
        };
        this.pending.add(finish); return finish;
    }
    /** A thrown hook after returned(OK) is infrastructure failure, never an earlier successful tail. */
    private call(invoke: (returned: (result?: number) => void) => void, done: (result: number) => void): void {
        if (this.clearing) { done(DPN.USERCANCEL); return; }
        if (this.pending.size >= 512) { done(DPN.TABLEFULL); return; }
        const finish = this.completion(done);
        let returned = false, invoking = true, result: number = DPN.OK;
        const complete = (hr: number = DPN.OK) => {
            if (returned) return; returned = true; result = hr;
            if (!invoking) finish(hr);
        };
        try { invoke(complete); }
        catch { if (!returned || result === DPN.OK) result = DPN.GENERIC; returned = true; }
        invoking = false; if (returned) finish(result);
    }
    notify(pair: Pair, add: boolean, hook: MemberHook | undefined, done: (result: number) => void): void {
        if (pair.generation !== this.generation || !this.records.has(pair) || this.notifying.has(pair) ||
            (add ? !pair.pendingAdd : !pair.pendingRemove)) { done(DPN.USERCANCEL); return; }
        this.notifying.add(pair);
        this.call(returned => { if (hook) hook(pair.group, pair.player, add, returned); else returned(); }, result => {
            this.notifying.delete(pair);
            if (result) { done(result); return; }
            if (pair.generation !== this.generation || !this.records.has(pair)) { done(DPN.USERCANCEL); return; }
            if (add) {
                pair.pendingAdd = false; pair.available = true;
                if (this.entries.get(pair.group)?.retired || this.entries.get(pair.player)?.retired) {
                    this.dropPair(pair, () => done(DPN.USERCANCEL)); return;
                }
                done(DPN.OK); return;
            }
            this.dropPair(pair, done);
        });
    }
    private dropPair(pair: Pair, done: (result: number) => void): void {
        if (!pair.referencesOwned || !this.records.has(pair)) { done(DPN.USERCANCEL); return; }
        if (this.linked.get(key(pair.group, pair.player)) === pair) this.linked.delete(key(pair.group, pair.player));
        pair.linked = false; pair.available = false; pair.pendingAdd = false; pair.pendingRemove = false;
        pair.referencesOwned = false; this.records.delete(pair);
        const group = this.entries.get(pair.group); if (group) group.entity.members = this.members(pair.group);
        // NT5 releases group then player refs, including any synchronous deferred destruction.
        this.release(pair.group, result => { if (result) done(result); else this.release(pair.player, done); });
    }
    private release(id: number, done: (result: number) => void): void {
        const row = this.entries.get(id);
        if (!row || row.refs < 1) { done(DPN.USERCANCEL); return; }
        row.refs--;
        if (!row.refs && !row.base && row.retired) { this.entries.delete(id); done(DPN.OK); return; }
        if (!row.refs && !row.base && row.needDestroy) { this.destroyNotification(id, row, done); return; }
        done(DPN.OK);
    }
    private destroyNotification(id: number, row: Entry, done: (result: number) => void): void {
        if (row.notified || row.notifying || this.entries.get(id) !== row) { done(DPN.USERCANCEL); return; }
        row.notifying = true;
        this.call(returned => { if (row.destroyHook) row.destroyHook(id, returned); else returned(); }, result => {
            row.notifying = false;
            if (result) { done(result); return; }
            if (this.entries.get(id) !== row) { done(DPN.USERCANCEL); return; }
            row.notified = true; row.created = false;
            if (row.state === "deleted") this.entries.delete(id);
            done(DPN.OK);
        });
    }
    /**
     * Start/validation result only: no done on immediate error. Its own linked
     * REMOVE tails are awaited. An already-unlinked held REMOVE is not awaited.
     */
    destroy(group: number, memberHook: MemberHook | undefined, destroyHook: DestroyHook | undefined, done: (result: number) => void): number {
        const row = this.entries.get(group);
        if (!row?.entity.group || row.retired) return DPN.INVALIDGROUP;
        if (row.state === "disconnecting") return DPN.INVALIDGROUP;
        if (row.state === "deleted") return DPN.CONNECTIONLOST;
        const own = [...this.linked.values()].filter(p => p.group === group);
        if (!row.created || own.some(p => p.pendingAdd || !p.available)) return DPN.UNSUPPORTED;
        if (this.pending.size >= 510) return DPN.TABLEFULL;
        const generation = this.generation, finish = this.completion(done);
        row.state = "disconnecting"; row.needDestroy = true; row.destroyHook = destroyHook;
        let index = 0;
        const next = (result: number) => {
            if (result) { finish(result); return; }
            if (generation !== this.generation || this.entries.get(group) !== row) { finish(DPN.USERCANCEL); return; }
            while (index < own.length) {
                const selected = own[index++];
                if (!selected.linked || this.linked.get(key(group, selected.player)) !== selected) continue;
                const pair = this.beginRemove(group, selected.player, null);
                if (typeof pair === "number") { finish(pair); return; }
                // Membership disappears before the actual implicit REMOVE callback.
                row.entity.members = this.members(group);
                this.notify(pair, false, memberHook, next); return;
            }
            row.base = false;
            if (row.refs === 0) this.destroyNotification(group, row, finish);
            else finish(DPN.OK);
        };
        next(DPN.OK); return DPN.OK;
    }
    committed(group: number): void {
        const row = this.entries.get(group); if (!row || row.retired || row.state !== "disconnecting") return;
        row.state = "deleted"; if (row.notified) this.entries.delete(group);
    }
    /** Housekeeping only; no invented deferred DESTROY_PLAYER callback policy. */
    retirePlayer(id: number): void { const row = this.entries.get(id); if (row && !row.entity.group) this.retire(id, row); }
    /** Existing AUTO-departure cleanup keeps its own callback policy and mints no new version. */
    retireGroup(id: number): void { const row = this.entries.get(id); if (row?.entity.group) this.retire(id, row); }
    private retire(id: number, row: Entry): void {
        row.retired = true; row.base = false; row.state = "deleted";
        // Resource retirement only. Existing callers own departure notifications;
        // held callbacks keep their references until their actual return.
        for (const pair of [...this.records]) if ((pair.group === id || pair.player === id) &&
            pair.linked && pair.available && !pair.pendingAdd && !pair.pendingRemove) this.dropPair(pair, () => {});
        if (!row.refs) this.entries.delete(id);
    }
    clear(result: number = DPN.USERCANCEL): void {
        if (this.clearing) return;
        this.clearing = true; ++this.generation;
        this.entries.clear(); this.linked.clear(); this.records.clear(); this.notifying.clear();
        try { for (const finish of [...this.pending]) { try { finish(result); } catch { /* Other owned continuations still retire. */ } } }
        finally { this.pending.clear(); this.clearing = false; }
    }
}
