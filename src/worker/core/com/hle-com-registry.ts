import type { Process } from '../process';
import type { HleComServer, HleComClass } from './hle-com-server';

const registrations = new WeakMap<Process, Map<string, { server: HleComServer; definition: HleComClass }>>();
/** Class activation stays process-local without importing COM implementations into the loader. */
export function registerHleComServer(process: Process, server: HleComServer, classes: readonly HleComClass[]): void {
    let entries = registrations.get(process);
    if (!entries) registrations.set(process, entries = new Map());
    for (const definition of classes) entries.set(definition.clsid.toLowerCase(), { server, definition });
}
export function lookupHleComClass(process: Process, clsid: string) {
    return registrations.get(process)?.get(clsid.toLowerCase());
}
