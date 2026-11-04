/**
 * Async thunks whose Promise may be dropped and the call re-issued: they have no
 * guest-visible effect before their first await (GetMessage). A savestate captures a thread
 * parked on one rewound to the call instead of waiting for the Promise (issue #66).
 */
// @transient(weak marks on host Promises; an entry dies with its Promise and is never part of a snapshot)
const restartable = new WeakSet<Promise<unknown>>();

export function markRestartable<T>(promise: Promise<T>): Promise<T> {
    restartable.add(promise);
    return promise;
}

export function isRestartable(promise: Promise<unknown>): boolean {
    return restartable.has(promise);
}
