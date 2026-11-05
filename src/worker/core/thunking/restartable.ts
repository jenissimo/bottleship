/**
 * Async thunks whose Promise may be dropped and the call re-issued (GetMessage). A savestate
 * captures a thread parked on one rewound to the call instead of waiting for the Promise
 * (issue #66).
 *
 * Invariant: at any macrotask boundary, a pending restartable Promise holds no result the
 * guest could observe. For GetMessage that is not "nothing happens before the first await":
 * the synchronous prefix of waitForMessage dequeues and polls input. It holds because every
 * path that resolves with a real message finishes the body and the thunk completion in
 * microtasks, and pauseEmulator() wakes waiters with WM_NULL. An `await` added after a
 * message is dequeued breaks it; such a body must report itself not restartable through
 * the predicate passed to markRestartable while it holds that message.
 */
// @transient(weak marks on host Promises; an entry dies with its Promise and is never part of a snapshot)
const restartable = new WeakMap<Promise<unknown>, () => boolean>();

const always = () => true;

export function markRestartable<T>(promise: Promise<T>, stillRestartable: () => boolean = always): Promise<T> {
    restartable.set(promise, stillRestartable);
    return promise;
}

export function restartableCheck(promise: Promise<unknown>): (() => boolean) | undefined {
    return restartable.get(promise);
}
