import type { WaitAnswer, WaitCompletion, WaitCompletionKind } from './types';
import { Logger, LogCategory } from '../logger';

export type WaitCompletionHandler = (completion: WaitCompletion, waitResult: number) => WaitAnswer;

/** @transient(behaviour, not data: each kind's owner module installs its handler when it is loaded) */
const handlers: (WaitCompletionHandler | undefined)[] = [];

export function setWaitCompletionHandler(kind: WaitCompletionKind, handler: WaitCompletionHandler): void {
    const current = handlers[kind];
    if (current && current !== handler) {
        Logger.error(LogCategory.THREAD, `wait completion kind ${kind} already has a handler; the new one is ignored`);
        return;
    }
    handlers[kind] = handler;
}

export function replaceWaitCompletionHandler(kind: WaitCompletionKind, handler: WaitCompletionHandler): void {
    handlers[kind] = handler;
}

export function completeWait(completion: WaitCompletion, waitResult: number): WaitAnswer {
    const handler = handlers[completion.kind];
    if (!handler) throw new Error(`no handler for wait completion kind ${completion.kind}`);
    return handler(completion, waitResult);
}
