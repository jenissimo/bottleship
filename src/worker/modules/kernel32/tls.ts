/**
 * Kernel32 TLS (Thread Local Storage) functions
 *
 * Atomic implementation for thread-local storage
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';

export const exports: Record<string, ThunkImplementation> = (() => {
    const exports: Record<string, ThunkImplementation> = {};

    exports['TlsAlloc'] = (ctx, mem, args) => {
        Logger.verbose(LogCategory.KERNEL32, 'TlsAlloc()');
        return System.getInstance().scheduler.tlsAlloc();
    };

    exports['TlsFree'] = (ctx, mem, args) => {
        const dwTlsIndex = args[0];

        Logger.verbose(LogCategory.KERNEL32, `TlsFree(${dwTlsIndex})`);

        return System.getInstance().scheduler.tlsFree(dwTlsIndex) ? 1 : 0;
    };

    exports['TlsGetValue'] = (ctx, mem, args) => {
        const dwTlsIndex = args[0];

        Logger.verbose(LogCategory.KERNEL32, `TlsGetValue(${dwTlsIndex})`);
        const scheduler = System.getInstance().scheduler;
        if (!scheduler.tlsIsAllocated(dwTlsIndex)) {
            scheduler.setLastError(87); // ERROR_INVALID_PARAMETER
            return 0;
        }
        // A NULL value is a successful result. Win32 makes it distinguishable from
        // failure by clearing LastError on every successful TlsGetValue call.
        scheduler.setLastError(0);
        return scheduler.tlsGetValue(dwTlsIndex);
    };

    exports['TlsSetValue'] = (ctx, mem, args) => {
        const dwTlsIndex = args[0];
        const lpTlsValue = args[1];

        Logger.verbose(LogCategory.KERNEL32, `TlsSetValue(${dwTlsIndex}, 0x${lpTlsValue.toString(16)})`);

        return System.getInstance().scheduler.tlsSetValue(dwTlsIndex, lpTlsValue) ? 1 : 0;
    };

    return exports;
})();
