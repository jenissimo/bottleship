export type IoReadPolicy = "may-block" | "park-preferred" | "must-not-block";

let policy: IoReadPolicy = "may-block";

export function enterIoReadPolicy(next: IoReadPolicy): IoReadPolicy {
    const previous = policy;
    policy = next;
    return previous;
}
export function restoreIoReadPolicy(previous: IoReadPolicy): void { policy = previous; }

export function currentIoReadPolicy(): IoReadPolicy { return policy; }

/** A synchronous scope: a lease must never survive an await or a guest thread switch. */
export function withIoReadPolicy<T>(next: IoReadPolicy, read: () => T): T {
    const previous = policy;
    policy = next;
    try { return read(); } finally { policy = previous; }
}
