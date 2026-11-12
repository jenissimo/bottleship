/**
 * Lease Registry - Memory Access Lifetime Tracking
 *
 * Tracks "leases" for memory access (primarily surface Lock/Unlock operations).
 * Provides safety by ensuring memory pointers are only accessed while leases are active.
 */

import { Logger, LogCategory } from '../logger';
import { memoryEventBuffer, MemoryEventType } from './memory-event-buffer';

export interface Lease {
    id: number;
    allocationId?: number;
    base: number;
    size: number;
    pitch?: number;
    rect?: { left: number; top: number; right: number; bottom: number };
    owner: string; // e.g., "IDirectDrawSurface7"
    perms: "r" | "rw";
    tag?: string;
    createdAt: number;
}

export class LeaseRegistry {
    private leases: Map<number, Lease> = new Map();
    private nextLeaseId = 1;

    activeLeaseCount(): number {
        return this.leases.size;
    }

    createLease(
        base: number,
        size: number,
        owner: string,
        perms: "r" | "rw",
        options?: {
            allocationId?: number;
            pitch?: number;
            rect?: { left: number; top: number; right: number; bottom: number };
            tag?: string;
        }
    ): number {
        // Check for conflicting leases to prevent Lock/Upload race
        // A write lease (rw) conflicts with ANY other lease
        // A read lease (r) conflicts with write leases (rw)
        const end = base + size;
        for (const existing of this.leases.values()) {
            const existingEnd = existing.base + existing.size;
            const overlap = base < existingEnd && end > existing.base;

            if (overlap) {
                // Write lease conflicts with ANY lease (read or write)
                if (perms === "rw" || existing.perms === "rw") {
                    Logger.warn(LogCategory.SYSTEM,
                        `⚠️ LEASE CONFLICT: ${perms} lease "${owner}" overlaps existing ${existing.perms} lease "${existing.owner}" ` +
                        `at 0x${base.toString(16)}-0x${end.toString(16)} (existing: 0x${existing.base.toString(16)}-0x${existingEnd.toString(16)}) - ` +
                        `SKIPPING to prevent race condition`
                    );
                    // Return error lease ID = 0
                    return 0;
                }
                // Read-only leases can overlap (multiple readers OK)
            }
        }

        const leaseId = this.nextLeaseId++;
        const lease: Lease = {
            id: leaseId,
            base,
            size,
            owner,
            perms,
            createdAt: performance.now(),
            ...options,
        };
        this.leases.set(leaseId, lease);

        memoryEventBuffer.record({
            timestamp: lease.createdAt,
            type: MemoryEventType.LOCK,
            address: base,
            size,
            context: `${owner} lease=${leaseId} tag=${lease.tag || ""}`,
        });

        Logger.verbose(LogCategory.SYSTEM,
            `Lease created: id=${leaseId} owner=${owner} addr=0x${base.toString(16)} ` +
            `size=0x${size.toString(16)} perms=${perms}`);
        return leaseId;
    }

    revokeLease(leaseId: number): boolean {
        const lease = this.leases.get(leaseId);
        if (!lease) {
            Logger.warn(LogCategory.SYSTEM, `Lease ${leaseId} not found (already revoked?)`);
            return false;
        }
        this.leases.delete(leaseId);

        memoryEventBuffer.record({
            timestamp: performance.now(),
            type: MemoryEventType.UNLOCK,
            address: lease.base,
            size: lease.size,
            context: `${lease.owner} lease=${leaseId}`,
        });

        const duration = performance.now() - lease.createdAt;
        Logger.verbose(LogCategory.SYSTEM,
            `Lease revoked: id=${leaseId} duration=${duration.toFixed(2)}ms`);
        return true;
    }

    validateLease(leaseId: number): Lease | null {
        return this.leases.get(leaseId) ?? null;
    }

    findLeasesByOwner(owner: string): Lease[] {
        return Array.from(this.leases.values()).filter(l => l.owner === owner);
    }

    revokeAllByOwner(owner: string): number {
        const toRevoke = this.findLeasesByOwner(owner);
        toRevoke.forEach(lease => this.revokeLease(lease.id));
        if (toRevoke.length > 0) {
            Logger.log(LogCategory.SYSTEM,
                `Revoked ${toRevoke.length} leases for owner ${owner}`);
        }
        return toRevoke.length;
    }

    getActiveLeases(): Lease[] {
        return Array.from(this.leases.values());
    }

    /** Drop all leases (game switch — surfaces are gone after Process.reset, leases are stale). */
    reset(): void {
        this.leases.clear();
        this.nextLeaseId = 1;
    }

    getStats(): { totalLeases: number; leasesByOwner: Record<string, number> } {
        const leasesByOwner: Record<string, number> = {};
        for (const lease of this.leases.values()) {
            leasesByOwner[lease.owner] = (leasesByOwner[lease.owner] || 0) + 1;
        }
        return {
            totalLeases: this.leases.size,
            leasesByOwner,
        };
    }
}

export const leaseRegistry = new LeaseRegistry();
