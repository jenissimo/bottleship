/**
 * Scheduler Module — Clean-Room Rewrite
 *
 * Unified thread scheduler with deterministic context switching,
 * centralized timer management, and push-based wait/wake.
 */

// Re-export all types
export * from './types';

// Re-export components
export { SyncObjectManager, type ThreadLookupFn } from './sync-objects';
export { WaitEngine } from './wait-engine';
export { TimerWheel, setTimerHandler, replaceTimerHandler, getTimerHandler, type TimerEntry, type TimerHandler } from './timer-wheel';
export { CallbackCoordinator, type QueuedCallback } from './callback-coord';
export { Scheduler } from './scheduler';
export { setFsBase, readFsDescriptorBase } from './fs-base';
export { setWaitCompletionHandler, replaceWaitCompletionHandler, completeWait, type WaitCompletionHandler } from './wait-completion';
