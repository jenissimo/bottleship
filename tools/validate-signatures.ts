#!/usr/bin/env bun

/**
 * Unified Signature Validation CLI Tool
 * 
 * Validates API descriptors against:
 * 1. Their implementations (API/Implementation validation)
 * 2. Reference signatures from header files (Reference validation)
 * 
 * Supports both COM interfaces (DirectX) and regular functions (MSS32, etc.)
 */

import { validateSignatures } from '../src/worker/tools/signature-validator';
import { validateReferenceSignatures } from '../src/worker/tools/reference-validator';
import * as path from 'path';
import * as fs from 'fs';

function formatError(error: any): string {
    const lines: string[] = [];
    
    lines.push(`  \x1b[31m✗ ${error.type}\x1b[0m: ${error.message}`);
    
    if (error.method) {
        lines.push(`    Method: ${error.method}`);
    }
    
    if (error.function) {
        lines.push(`    Function: ${error.function}`);
    }
    
    if (error.interface) {
        lines.push(`    Interface: ${error.interface}`);
    }
    
    if (error.expected !== undefined) {
        lines.push(`    Expected: ${JSON.stringify(error.expected)}`);
    }
    
    if (error.actual !== undefined) {
        lines.push(`    Actual: ${JSON.stringify(error.actual)}`);
    }
    
    return lines.join('\n');
}

function formatWarning(warning: any): string {
    return `  \x1b[33m⚠ ${warning.type}\x1b[0m: ${warning.message}`;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    let apiDir = path.join(process.cwd(), 'src/worker/api');
    let modulesDir = path.join(process.cwd(), 'src/worker/modules');
    let referenceDir = path.join(process.cwd(), 'tools/reference');
    let moduleName: string | null = null;
    let reference = false;
    let apiOnly = false;
    let report = false;
    let skipMissing = false;
    
    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--reference') {
            reference = true;
        } else if (arg === '--api-only') {
            apiOnly = true;
        } else if (arg === '--report') {
            report = true;
        } else if (arg === '--skip-missing') {
            skipMissing = true;
        } else if (arg === '--module' && i + 1 < args.length) {
            moduleName = args[++i];
        } else if (arg === '--api-dir' && i + 1 < args.length) {
            apiDir = args[++i];
        } else if (arg === '--modules-dir' && i + 1 < args.length) {
            modulesDir = args[++i];
        } else if (arg === '--reference-dir' && i + 1 < args.length) {
            referenceDir = args[++i];
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: bun run validate-signatures [options]

Options:
  --module <name>        Validate specific module only
  --reference            Include validation against reference headers
  --api-only             Only validate API/Implementation (skip reference)
  --api-dir <path>       Path to API directory (default: src/worker/api)
  --modules-dir <path>   Path to modules directory (default: src/worker/modules)
  --reference-dir <path> Path to reference directory (default: tools/reference)
  --report               Generate detailed JSON report
  --skip-missing          Skip missing_method and missing_function errors (show only argCount/vtable errors)
  --help, -h             Show this help message

Examples:
  bun run validate-signatures                    # API/Implementation validation for all modules
  bun run validate-signatures --reference        # Include reference validation
  bun run validate-signatures --module mss32     # Validate specific module
  bun run validate-signatures --api-only         # Skip reference validation
  bun run validate-signatures --report > report.json
`);
            process.exit(0);
        }
    }
    
    // Default: validate all modules with API/Implementation check
    // If --reference is specified, also validate against reference headers
    
    try {
        // 1. API/Implementation validation (always runs unless --reference-only)
        if (!reference || !apiOnly) {
            console.log('Validating API/Implementation signatures...\n');
            console.log(`API directory: ${apiDir}`);
            console.log(`Modules directory: ${modulesDir}\n`);
            
            if (moduleName) {
                // Validate single module
                const apiFile = path.join(apiDir, `${moduleName}.api.ts`);
                const moduleDir = path.join(modulesDir, moduleName);
                
                if (!fs.existsSync(apiFile)) {
                    console.error(`API file not found: ${apiFile}`);
                    process.exit(1);
                }
                
                if (!fs.existsSync(moduleDir)) {
                    console.error(`Module directory not found: ${moduleDir}`);
                    process.exit(1);
                }
                
                // Use signature-validator for single module
                const { SignatureValidator } = require('../src/worker/tools/signature-validator');
                const v = new SignatureValidator();
                const result = v.validateModule(moduleName, apiFile, moduleDir);
                
                console.log(`\nModule: ${result.moduleName}`);
                console.log(`Status: ${result.valid ? '✅ PASS' : '❌ FAIL'}`);
                console.log(`Functions: ${result.stats.totalFunctions} implemented`);
                
                if (result.errors.length > 0) {
                    console.log('Errors:');
                    for (const error of result.errors) {
                        console.log(`  ❌ ${error.functionName}: ${error.message}`);
                    }
                }
                
                if (result.warnings.length > 0) {
                    console.log('Warnings:');
                    for (const warning of result.warnings) {
                        console.log(`  ⚠️  ${warning.functionName}: ${warning.message}`);
                    }
                }
                
                if (!result.valid) {
                    process.exit(1);
                }
            } else {
                // Validate all modules
                validateSignatures(apiDir, modulesDir);
            }
        }
        
        // 2. Reference validation (if requested)
        if (reference && !apiOnly) {
            console.log('\n' + '─'.repeat(60));
            console.log('Validating against reference signatures...\n');
            console.log(`Reference directory: ${referenceDir}\n`);
            
            const apiFiles = moduleName 
                ? [path.join(apiDir, `${moduleName}.api.ts`)]
                : fs.readdirSync(apiDir).filter(f => f.endsWith('.api.ts')).map(f => path.join(apiDir, f));
            
            let totalStats = {
                interfacesChecked: 0,
                methodsChecked: 0,
                functionsChecked: 0,
                errorsFound: 0,
                warningsFound: 0
            };
            const allErrors: any[] = [];
            const allWarnings: any[] = [];
            
            for (const apiFile of apiFiles) {
                if (!fs.existsSync(apiFile)) continue;
                
                const result = await validateReferenceSignatures(apiFile, referenceDir);
                totalStats.interfacesChecked += result.stats.interfacesChecked || 0;
                totalStats.methodsChecked += result.stats.methodsChecked || 0;
                totalStats.functionsChecked += result.stats.functionsChecked || 0;
                totalStats.errorsFound += result.stats.errorsFound;
                totalStats.warningsFound += result.stats.warningsFound;
                allErrors.push(...result.errors);
                allWarnings.push(...result.warnings);
            }
            
            // Print statistics
            console.log('─'.repeat(60));
            console.log('Reference Validation Results:');
            if (totalStats.interfacesChecked > 0) {
                console.log(`  Interfaces checked: ${totalStats.interfacesChecked}`);
                console.log(`  Methods checked: ${totalStats.methodsChecked}`);
            }
            if (totalStats.functionsChecked > 0) {
                console.log(`  Functions checked: ${totalStats.functionsChecked}`);
            }
            // Filter errors if --skip-missing is set (hide missing_method/missing_function errors)
            const errorsToShow = skipMissing 
                ? allErrors.filter(e => e.type !== 'missing_method' && e.type !== 'missing_function')
                : allErrors;
            const filteredErrorsCount = skipMissing 
                ? allErrors.filter(e => e.type === 'missing_method' || e.type === 'missing_function').length
                : 0;
            const displayedErrorsCount = totalStats.errorsFound - filteredErrorsCount;
            
            console.log(`  Errors: ${displayedErrorsCount}${skipMissing && filteredErrorsCount > 0 ? ` (${filteredErrorsCount} missing_method/missing_function skipped)` : ''}`);
            console.log(`  Warnings: ${totalStats.warningsFound}`);
            console.log('─'.repeat(60));
            
            // Print warnings (show all warnings)
            if (allWarnings.length > 0) {
                console.log('\n\x1b[33mWarnings:\x1b[0m');
                for (const warning of allWarnings) {
                    console.log(formatWarning(warning));
                }
            }
            
            // Print errors (filter missing_method/missing_function if --skip-missing is set)
            if (errorsToShow.length > 0) {
                console.log('\n\x1b[31mErrors:\x1b[0m');
                
                // Group by interface/function
                const errorsByGroup = new Map<string, any[]>();
                for (const error of errorsToShow) {
                    const key = error.interface || error.function || 'unknown';
                    if (!errorsByGroup.has(key)) {
                        errorsByGroup.set(key, []);
                    }
                    errorsByGroup.get(key)!.push(error);
                }
                
                for (const [groupName, errors] of errorsByGroup) {
                    console.log(`\n  \x1b[1m${groupName}:\x1b[0m`);
                    for (const error of errors) {
                        console.log(formatError(error));
                    }
                }
                
                console.log('\n');
            }
            
            // Generate report if requested
            if (report) {
                const reportData = {
                    timestamp: new Date().toISOString(),
                    stats: totalStats,
                    errors: allErrors,
                    warnings: allWarnings
                };
                console.log(JSON.stringify(reportData, null, 2));
            }
            
            // Exit with error code if validation failed (only count non-filtered errors)
            if (errorsToShow.length > 0) {
                console.log('\x1b[31m✗ Reference validation failed!\x1b[0m');
                process.exit(1);
            } else {
                console.log('\n\x1b[32m✓ All reference signatures are valid!\x1b[0m');
            }
        }
        
    } catch (error: any) {
        console.error('\x1b[31mFatal error:\x1b[0m', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

main();
