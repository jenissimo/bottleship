/**
 * Shared naming utilities for API modules and tools
 */

export const API_SPECIAL_CASES: Record<string, string> = {
    'd3d9': 'D3D9',
    'dsound': 'DSound',
    'gdi32': 'GDI32',
    'user32': 'User32',
    'kernel32': 'Kernel32',
    'advapi32': 'Advapi32',
    'winmm': 'WinMM',
    'ddraw': 'DDraw',
    'dinput': 'DInput',
    'mss32': 'MSS32',
    'dplayx': 'DPlayX',
    'wsock32': 'Wsock32',
    'version': 'Version',
    'shell32': 'Shell32',
    'comctl32': 'Comctl32',
    'smackw32': 'SmackW32',
    'binkw32': 'BinkW32',
    'lgvid': 'Lgvid'
};

/**
 * Capitalizes a string, taking into account WinAPI special cases (abbreviations)
 */
export function capitalizeApiName(str: string): string {
    if (API_SPECIAL_CASES[str]) {
        return API_SPECIAL_CASES[str];
    }

    // Default: capitalize first letter
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Gets a safe import name for a category (handles dashes and reserved words)
 */
export function getSafeImportName(category: string): string {
    const baseName = category.replace(/-/g, '_');
    
    const reservedWords = [
        'class', 'function', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 
        'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'return', 
        'break', 'continue', 'debugger', 'with', 'new', 'delete', 'typeof', 'void', 
        'this', 'super', 'extends', 'implements', 'interface', 'enum', 'package', 
        'import', 'export', 'static', 'public', 'private', 'protected', 'abstract', 
        'readonly', 'async', 'await', 'yield', 'process'
    ];

    if (reservedWords.includes(baseName)) {
        return baseName + '_';
    }
    return baseName;
}
