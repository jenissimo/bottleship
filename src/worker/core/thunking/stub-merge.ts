/**
 * Merging a stub table into a table of real implementations.
 *
 * `Object.assign(exports, createXStubsExports())` is order-dependent: every real handler
 * registered BEFORE the merge is silently replaced by the stub. The failure is invisible —
 * the guest gets a success code and an untouched out-param, then derails somewhere far away
 * (a NULL vtable pointer dereferenced through an identity-mapped page raises no #PF; it reads
 * garbage and jumps into it).
 *
 * A real implementation must always win, whatever the registration order, so stub tables go
 * in through this function instead. The collision is also reported rather than swallowed:
 * a stub table listing a name somebody implemented is dead weight that will mislead the next
 * reader, and `tools/validate-stub-tables.ts` fails the gate on it.
 */
import { Logger, LogCategory } from "../logger";

export function assignStubsOnce<T>(target: Record<string, T>, stubs: Record<string, T>, label: string): void {
    for (const key of Object.keys(stubs)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
            Logger.warn(LogCategory.SYSTEM,
                `${label}: stub "${key}" ignored — a real implementation is already registered. ` +
                `Remove it from the stub table.`);
            continue;
        }
        target[key] = stubs[key]!;
    }
}
