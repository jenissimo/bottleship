import type { Process } from '../process';
import type { HleComServer, HleComClass } from './hle-com-server';
import { comApartments } from './apartment';

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

/** All exported COM/OLE/WinRT leave APIs share the same final-apartment policy. */
export function leaveComApartment(process: Process, threadId: number, ole = false): void {
    const initialized = comApartments.hasApartments();
    if (ole) comApartments.leaveOle(threadId); else comApartments.leave(threadId);
    if (initialized && !comApartments.hasApartments()) releaseHleComServerLoads(process);
}

/** Final apartment teardown releases only COM's ownership, never imports/LoadLibrary. */
export function releaseHleComServerLoads(process: Process, reset = false): void {
    const servers = new Set([...registrations.get(process)?.values() ?? []].map(entry => entry.server));
    for (const server of servers) {
        if (reset) server.releaseLoaderReference(); else server.releaseUnusedLoaderReference();
    }
}
