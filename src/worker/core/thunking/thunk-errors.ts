// thunk-errors.ts
// Typed error classes for thunk system

// Windows API error codes
export const ERROR_SUCCESS = 0;
export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_NOT_SUPPORTED = 50;
export const ERROR_INVALID_FUNCTION = 1;
export const ERROR_INVALID_HANDLE = 6;
export const ERROR_INSUFFICIENT_BUFFER = 122;
export const ERROR_NO_SYSTEM_RESOURCES = 1450;

/**
 * Base error class for thunk system errors
 */
export class ThunkError extends Error {
    constructor(
        message: string,
        public readonly errorCode: number = ERROR_INVALID_PARAMETER,
        public readonly dllName?: string,
        public readonly functionName?: string
    ) {
        super(message);
        this.name = 'ThunkError';
    }
}

/**
 * Error for callback invocation failures
 */
export class CallbackError extends Error {
    constructor(
        message: string,
        public readonly callbackAddress?: number,
        public readonly errorCode: number = ERROR_INVALID_PARAMETER
    ) {
        super(message);
        this.name = 'CallbackError';
    }
}

/**
 * Error for missing or invalid thunk implementation
 */
export class ThunkNotImplementedError extends ThunkError {
    constructor(dllName: string, functionName: string) {
        super(
            `Thunk not implemented: ${dllName}:${functionName}`,
            ERROR_NOT_SUPPORTED,
            dllName,
            functionName
        );
        this.name = 'ThunkNotImplementedError';
    }
}

/**
 * Error for invalid stack operations
 */
export class StackError extends ThunkError {
    constructor(message: string, public readonly esp?: number) {
        super(message, ERROR_INVALID_PARAMETER);
        this.name = 'StackError';
    }
}

/**
 * Error for memory access violations
 */
export class MemoryAccessError extends ThunkError {
    constructor(message: string, public readonly address?: number) {
        super(message, ERROR_INVALID_PARAMETER);
        this.name = 'MemoryAccessError';
    }
}
