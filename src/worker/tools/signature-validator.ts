/**
 * Signature Validator
 *
 * Validates that API descriptors match their implementations
 * Checks function signatures, parameter counts, and implementation completeness
 * Using TypeScript AST parsing for robust validation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** `IFoo_Method` — a COM vtable slot, declared as an Interface/method pair rather than a flat export. */
// Case-insensitive: the implementation table lowercases its keys while the descriptors
// are written in the SDK's casing, so a case-sensitive test silently matches neither.
const COM_METHOD_NAME = /^i[a-z0-9][a-z0-9]*_[a-z0-9_]+$/i;

export interface ValidationResult {
    moduleName: string;
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationWarning[];
    stats: {
        totalFunctions: number;
        implementedFunctions: number;
        totalMethods: number;
        implementedMethods: number;
    };
}

export interface ValidationError {
    type: 'missing_function' | 'missing_method' | 'parameter_mismatch' | 'signature_mismatch' | 'invalid_signature' | 'missing_parameters' | 'invalid_return_type' | 'missing_stackcleanup' | 'vtable_incomplete';
    functionName: string;
    message: string;
    expected?: any;
    actual?: any;
}

export interface ValidationWarning {
    type: 'incomplete_implementation' | 'unimplemented_function';
    functionName: string;
    message: string;
}

export interface InternalFunctionInfo {
    name: string;
    params: string[];
    hasReturnObject: boolean;
    hasStackCleanup: boolean;
    hasReturnValue: boolean;
    isAsync: boolean;
    filePath: string;
    line: number;
}

export class SignatureValidator {
    /**
     * Helper to check if expression is 'exports' or 'this.exports'
     */
    private isExportsExpression(expression: ts.Expression): boolean {
        // Check for: exports[...]
        if (ts.isIdentifier(expression) && expression.text === 'exports') {
            return true;
        }
        // Check for: this.exports[...]
        if (ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.name) && expression.name.text === 'exports' &&
            expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
            return true;
        }
        return false;
    }

    /**
     * Resolve a thunk implementation node from an assignment RHS.
     * Handles direct arrows, local identifier refs, and factory calls that return arrows.
     */
    private resolveThunkNode(
        right: ts.Expression,
        namedFunctions: Map<string, ts.ArrowFunction | ts.FunctionExpression>
    ): ts.ArrowFunction | ts.FunctionExpression | null {
        if (ts.isArrowFunction(right) || ts.isFunctionExpression(right)) {
            return right;
        }

        if (ts.isIdentifier(right)) {
            return namedFunctions.get(right.text) ?? null;
        }

        if (ts.isCallExpression(right) && ts.isIdentifier(right.expression)) {
            const factory = namedFunctions.get(right.expression.text);
            if (!factory) return null;
            // (a) => (ctx, mem, args) => { ... }
            if (ts.isArrowFunction(factory) && !ts.isBlock(factory.body)) {
                if (ts.isArrowFunction(factory.body) || ts.isFunctionExpression(factory.body)) {
                    return factory.body;
                }
            }
            // (a) => { return (ctx, mem, args) => { ... }; }
            if (ts.isArrowFunction(factory) && ts.isBlock(factory.body)) {
                for (const stmt of factory.body.statements) {
                    if (ts.isReturnStatement(stmt) && stmt.expression) {
                        if (ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression)) {
                            return stmt.expression;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Scan implementation files and extract implemented functions using TS AST
     */
    scanImplementationFile(filePath: string): InternalFunctionInfo[] {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const functions: InternalFunctionInfo[] = [];
        const functionsByName = new Map<string, InternalFunctionInfo>();
        const exportAliases = new Map<string, string>();

        const addFunction = (info: InternalFunctionInfo): void => {
            functions.push(info);
            functionsByName.set(info.name.toLowerCase(), info);
        };

        // Collect const/var/function declarations that hold thunk implementations
        const namedFunctions = new Map<string, ts.ArrowFunction | ts.FunctionExpression>();
        const collectNamedFunctions = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.initializer) {
                const varName = ts.isIdentifier(node.name) ? node.name.text : null;
                if (varName && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
                    namedFunctions.set(varName, node.initializer);
                }
            }
            if (ts.isFunctionDeclaration(node) && node.name && node.body) {
                namedFunctions.set(node.name.text, node);
            }
            ts.forEachChild(node, collectNamedFunctions);
        };
        collectNamedFunctions(sourceFile);

        // Collect all const arrays with string literals
        // e.g., const d3d3Stubs = ["Initialize", "EnumDevices", ...]
        const stubArrays = new Map<string, string[]>();
        const collectArrays = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
                const varName = ts.isIdentifier(node.name) ? node.name.text : null;
                if (varName) {
                    const elements: string[] = [];
                    for (const el of node.initializer.elements) {
                        if (ts.isStringLiteral(el)) {
                            elements.push(el.text);
                        }
                    }
                    if (elements.length > 0) {
                        stubArrays.set(varName, elements);
                    }
                }
            }
            ts.forEachChild(node, collectArrays);
        };
        collectArrays(sourceFile);

        const recordExportAssignment = (funcName: string, right: ts.Expression): void => {
            const thunkNode = this.resolveThunkNode(right, namedFunctions);
            if (thunkNode) {
                addFunction(this.extractFunctionInfo(funcName, thunkNode, sourceFile, filePath));
                return;
            }

            // exports["Alias"] = exports["Target"] or this.exports[...] = this.exports[...]
            if (ts.isElementAccessExpression(right) && this.isExportsExpression(right.expression)) {
                const targetKey = right.argumentExpression;
                if (ts.isStringLiteral(targetKey) || ts.isNoSubstitutionTemplateLiteral(targetKey)) {
                    exportAliases.set(funcName.toLowerCase(), targetKey.text);
                }
            }
        };

        const visit = (node: ts.Node) => {
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const left = node.left;
                if (ts.isElementAccessExpression(left) && this.isExportsExpression(left.expression)) {
                    const argument = left.argumentExpression;
                    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
                        recordExportAssignment(argument.text, node.right);
                    } else if (ts.isIdentifier(argument)) {
                        // Resolved later via for-of key-variable patterns
                    }
                }
            }

            if (ts.isForOfStatement(node)) {
                const forOfFunctions = this.extractForOfExports(node, stubArrays, sourceFile, filePath, exportAliases, namedFunctions);
                for (const info of forOfFunctions) {
                    addFunction(info);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);

        // Resolve export aliases (including transitive chains)
        for (let pass = 0; pass < 8; pass++) {
            let resolved = false;
            for (const [alias, target] of exportAliases) {
                if (functionsByName.has(alias)) continue;
                const targetInfo = functionsByName.get(target.toLowerCase());
                if (!targetInfo) continue;
                addFunction({ ...targetInfo, name: alias });
                resolved = true;
            }
            if (!resolved) break;
        }

        return functions;
    }

    /**
     * Extract function exports from for-of loops like:
     * for (const method of d3d3Stubs) { exports[`IDirect3D3_${method}`] = () => D3D_OK; }
     */
    private extractForOfExports(
        node: ts.ForOfStatement,
        stubArrays: Map<string, string[]>,
        sourceFile: ts.SourceFile,
        filePath: string,
        exportAliases: Map<string, string>,
        namedFunctions: Map<string, ts.ArrowFunction | ts.FunctionExpression>
    ): InternalFunctionInfo[] {
        const results: InternalFunctionInfo[] = [];

        // Get the iteration variable name (e.g., "method")
        const initializer = node.initializer;
        if (!ts.isVariableDeclarationList(initializer)) return results;
        const decl = initializer.declarations[0];
        if (!decl || !ts.isIdentifier(decl.name)) return results;
        const iterVar = decl.name.text;

        // Get the array being iterated (e.g., "d3d3Stubs")
        const iterExpr = node.expression;
        if (!ts.isIdentifier(iterExpr)) return results;
        const arrayName = iterExpr.text;
        const stubNames = stubArrays.get(arrayName);
        if (!stubNames) return results;

        const body = node.statement;
        if (!ts.isBlock(body)) return results;

        type KeyTemplate = { head: string; tail: string };
        const keyVarTemplates = new Map<string, KeyTemplate>();

        const parseIterTemplate = (tmpl: ts.TemplateExpression): KeyTemplate | null => {
            if (tmpl.templateSpans.length !== 1) return null;
            const span = tmpl.templateSpans[0];
            if (!ts.isIdentifier(span.expression) || span.expression.text !== iterVar) return null;
            return { head: tmpl.head.text, tail: span.literal.text };
        };

        const expandTemplate = (tpl: KeyTemplate, stubName: string): string =>
            `${tpl.head}${stubName}${tpl.tail}`;

        const collectKeyVars = (stmt: ts.Statement): void => {
            if (ts.isIfStatement(stmt)) {
                if (stmt.thenStatement) {
                    if (ts.isBlock(stmt.thenStatement)) {
                        for (const nested of stmt.thenStatement.statements) collectKeyVars(nested);
                    } else {
                        collectKeyVars(stmt.thenStatement);
                    }
                }
                if (stmt.elseStatement) {
                    if (ts.isBlock(stmt.elseStatement)) {
                        for (const nested of stmt.elseStatement.statements) collectKeyVars(nested);
                    } else {
                        collectKeyVars(stmt.elseStatement);
                    }
                }
                return;
            }
            if (!ts.isVariableStatement(stmt)) return;
            for (const varDecl of stmt.declarationList.declarations) {
                if (!varDecl.initializer || !ts.isTemplateExpression(varDecl.initializer)) continue;
                if (!ts.isIdentifier(varDecl.name)) continue;
                const tpl = parseIterTemplate(varDecl.initializer);
                if (tpl) keyVarTemplates.set(varDecl.name.text, tpl);
            }
        };

        const resolveExportKey = (keyExpr: ts.Expression | undefined): KeyTemplate | null => {
            if (!keyExpr) return null;
            if (ts.isTemplateExpression(keyExpr)) return parseIterTemplate(keyExpr);
            if (ts.isIdentifier(keyExpr)) return keyVarTemplates.get(keyExpr.text) ?? null;
            return null;
        };

        const processExportAssign = (stmt: ts.Statement): void => {
            if (ts.isIfStatement(stmt)) {
                if (stmt.thenStatement) {
                    if (ts.isBlock(stmt.thenStatement)) {
                        for (const nested of stmt.thenStatement.statements) processExportAssign(nested);
                    } else {
                        processExportAssign(stmt.thenStatement);
                    }
                }
                if (stmt.elseStatement) {
                    if (ts.isBlock(stmt.elseStatement)) {
                        for (const nested of stmt.elseStatement.statements) processExportAssign(nested);
                    } else {
                        processExportAssign(stmt.elseStatement);
                    }
                }
                return;
            }

            if (!ts.isExpressionStatement(stmt)) return;
            const expr = stmt.expression;
            if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;

            const left = expr.left;
            if (!ts.isElementAccessExpression(left) || !this.isExportsExpression(left.expression)) return;

            const leftTpl = resolveExportKey(left.argumentExpression);
            if (!leftTpl) return;

            const right = expr.right;
            // Body assigns a thunk: an inline arrow/function, a named function reference
            // (e.g. `exports[`${p}_QueryInterface`] = d3d9QueryInterface`), or a factory call.
            const thunkNode = this.resolveThunkNode(right, namedFunctions);
            if (thunkNode) {
                for (const stubName of stubNames) {
                    const funcName = expandTemplate(leftTpl, stubName);
                    results.push(this.extractFunctionInfo(funcName, thunkNode, sourceFile, filePath));
                }
                return;
            }

            if (ts.isElementAccessExpression(right) && this.isExportsExpression(right.expression)) {
                const rightTpl = resolveExportKey(right.argumentExpression);
                if (!rightTpl) return;
                for (const stubName of stubNames) {
                    const aliasName = expandTemplate(leftTpl, stubName);
                    const targetName = expandTemplate(rightTpl, stubName);
                    exportAliases.set(aliasName.toLowerCase(), targetName);
                }
            }
        };

        for (const stmt of body.statements) {
            collectKeyVars(stmt);
        }
        for (const stmt of body.statements) {
            processExportAssign(stmt);
        }

        return results;
    }

    private extractFunctionInfo(name: string, node: ts.ArrowFunction | ts.FunctionExpression, sourceFile: ts.SourceFile, filePath: string): InternalFunctionInfo {
        const params = node.parameters.map(p => {
            if (ts.isIdentifier(p.name)) return p.name.text;
            return 'unknown';
        });

        let hasReturnObject = false;
        let hasStackCleanup = false;
        let hasReturnValue = false;

        /** A `return` belonging to a NESTED function is not this thunk's return value. The walk
         *  must stop at every function boundary: a handler whose local helper returns
         *  `{ addr, fvf }` is otherwise reported as a ThunkResult missing `stackCleanup`, and a
         *  false positive here trains the reader to ignore the one real one. */
        const isNestedFunction = (n: ts.Node): boolean =>
            ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
            || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
            || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isClassDeclaration(n)
            || ts.isClassExpression(n);

        const checkReturn = (n: ts.Node) => {
            if (ts.isReturnStatement(n) && n.expression) {
                hasReturnValue = true;
                if (ts.isObjectLiteralExpression(n.expression)) {
                    hasReturnObject = true;
                    for (const prop of n.expression.properties) {
                        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                            if (prop.name.text === 'stackCleanup') hasStackCleanup = true;
                        } else if (ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                            if (prop.name.text === 'stackCleanup') hasStackCleanup = true;
                        }
                    }
                }
            }
            ts.forEachChild(n, (child) => {
                if (isNestedFunction(child)) return;
                checkReturn(child);
            });
        };

        // Arrow functions might have an implicit return (no block)
        if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
            hasReturnValue = true;
            if (ts.isObjectLiteralExpression(node.body)) {
                hasReturnObject = true;
                for (const prop of node.body.properties) {
                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                        if (prop.name.text === 'stackCleanup') hasStackCleanup = true;
                    } else if (ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                        if (prop.name.text === 'stackCleanup') hasStackCleanup = true;
                    }
                }
            }
        } else {
            // Guarded entry, same rule as the recursion: a helper declared at the top of the
            // body is still a nested function, and its returns are not this thunk's.
            ts.forEachChild(node.body, (child) => {
                if (isNestedFunction(child)) return;
                checkReturn(child);
            });
        }

        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

        return {
            name,
            params,
            hasReturnObject,
            hasStackCleanup,
            hasReturnValue,
            isAsync: !!(node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)),
            filePath,
            line: line + 1
        };
    }

    /**
     * Validate module implementation
     * implPath can be a directory (e.g., ddraw/) or a single file (e.g., binkw32.ts)
     */
    validateModule(moduleName: string, apiFile: string | null, implPath: string): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationWarning[] = [];

        if (!fs.existsSync(implPath)) {
            errors.push({
                type: 'missing_function',
                functionName: '*',
                message: `Implementation not found: ${implPath}`
            });
            return { moduleName, valid: false, errors, warnings, stats: { totalFunctions: 0, implementedFunctions: 0, totalMethods: 0, implementedMethods: 0 } };
        }

        const functions: InternalFunctionInfo[] = [];
        try {
            const stat = fs.statSync(implPath);
            if (stat.isDirectory()) {
                // Directory-based module (e.g., ddraw/, kernel32/)
                const scanDir = (dir: string) => {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            scanDir(fullPath);
                        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                            functions.push(...this.scanImplementationFile(fullPath));
                        }
                    }
                };
                scanDir(implPath);
            } else if (stat.isFile() && implPath.endsWith('.ts')) {
                // File-based module (e.g., binkw32.ts, msvcrt.ts)
                functions.push(...this.scanImplementationFile(implPath));
            }
        } catch (error: any) {
            errors.push({
                type: 'signature_mismatch',
                functionName: '*',
                message: `Failed to scan directory: ${error.message}`
            });
        }

        for (const func of functions) {
            this.validateFunctionInfo(func, errors);
        }

        // Compare with API descriptor if available
        if (apiFile && fs.existsSync(apiFile)) {
            this.validateAgainstApiDescriptor(moduleName, apiFile, functions, errors, warnings);
        }

        const stats = {
            totalFunctions: functions.length,
            implementedFunctions: functions.length,
            totalMethods: 0,
            implementedMethods: 0
        };

        return {
            moduleName,
            valid: errors.length === 0,
            errors,
            warnings,
            stats
        };
    }

    private validateFunctionInfo(func: InternalFunctionInfo, errors: ValidationError[]): void {
        const { name, params, hasReturnObject, hasStackCleanup, hasReturnValue } = func;

        // 1. Parameter validation
        // Skip parameter validation for simple stubs (no params, returns constant)
        // These are intentionally minimal: () => D3D_OK
        const isSimpleStub = params.length === 0 && hasReturnValue && !hasReturnObject;
        if (isSimpleStub) {
            // Simple stubs are OK - they don't need ctx/mem/args
            return;
        }

        if (params.length === 0) {
            errors.push({
                type: 'missing_parameters',
                functionName: name,
                message: `Function has no parameters. Should have (ctx, mem, args).`
            });
        } else {
            // Basic checks for param names (senior heuristic)
            // Strip leading underscores — unused params are conventionally _prefixed
            const stripUnderscore = (s: string) => s.replace(/^_+/, '');
            const first = stripUnderscore(params[0]).toLowerCase();
            if (!['ctx', 'context', 'c', 'sysctx', 'ctxthunk', 'sysctx', 'thunkctx'].includes(first)) {
                errors.push({
                    type: 'invalid_signature',
                    functionName: name,
                    message: `First parameter should be 'ctx', got '${params[0]}'`
                });
            }

            if (params.length >= 2) {
                const second = stripUnderscore(params[1]).toLowerCase();
                if (!['mem', 'memory', 'view', 'buffer', 'm'].includes(second)) {
                    errors.push({
                        type: 'invalid_signature',
                        functionName: name,
                        message: `Second parameter should be 'mem' or 'memory', got '${params[1]}'`
                    });
                }
            }

            if (params.length >= 3) {
                const third = stripUnderscore(params[2]).toLowerCase();
                if (!['args', 'argv'].includes(third)) {
                    errors.push({
                        type: 'invalid_signature',
                        functionName: name,
                        message: `Third parameter should be 'args', got '${params[2]}'`
                    });
                }
            }

            if (params.length < 3) {
                errors.push({
                    type: 'missing_parameters',
                    functionName: name,
                    message: `Function should have at least 3 parameters (ctx, mem, args), but has ${params.length}`
                });
            }
        }

        // 2. Return value validation
        if (hasReturnObject && !hasStackCleanup) {
            // This is a common source of bugs - returning an object but forgetting stackCleanup
            errors.push({
                type: 'missing_stackcleanup',
                functionName: name,
                message: `ThunkResult object is missing 'stackCleanup'. This can cause stack corruption in stdcall.`
            });
        }

        if (!hasReturnValue && !func.isAsync) {
            errors.push({
                type: 'invalid_return_type',
                functionName: name,
                message: `Function does not return a value. All thunks must return a number or ThunkResult.`
            });
        }
    }

    /**
     * Compare implementation against the API descriptor
     */
    private validateAgainstApiDescriptor(moduleName: string, apiFile: string, implemented: InternalFunctionInfo[], errors: ValidationError[], warnings: ValidationWarning[]): void {
        const apiContent = fs.readFileSync(apiFile, 'utf-8');
        const apiFunctions = this.extractApiFunctions(apiFile, apiContent);
        const apiInterfaces = this.extractApiInterfaces(apiFile, apiContent);
        let unverifiable = 0;

        // Build set of implemented function names (lowercase for case-insensitive check)
        const implementedNames = new Set(implemented.map(f => f.name.toLowerCase()));

        // Check each implemented function
        for (const impl of implemented) {
            let expectedArgs = apiFunctions[impl.name];

            // Try fallback to base name if A/W version not found
            if (expectedArgs === undefined && /[WA]$/.test(impl.name)) {
                const baseName = impl.name.replace(/[WA]$/, "");
                expectedArgs = apiFunctions[baseName];
            }

            // Try case-insensitive lookup
            if (expectedArgs === undefined) {
                const lowerName = impl.name.toLowerCase();
                const match = Object.keys(apiFunctions).find(k => k.toLowerCase() === lowerName);
                if (match) expectedArgs = apiFunctions[match];
            }

            if (expectedArgs === undefined) {
                // Two very different things reach here, and reporting them as one is why this
                // warning fired 297 times — the whole of the gate's warning output — and was
                // silenced for two modules by NAME rather than by mechanism. A check that
                // calls its entire input suspect says the same as a check that says nothing:
                // the one real finding in that list (an implemented export absent from its
                // .api.ts, and therefore unreachable) stayed invisible until a title went
                // silent.
                //
                // A COM vtable method is declared as an Interface/method pair, and
                // extractApiInterfaces openly cannot enumerate a method list built by a
                // computed spread. So for those names this check is UNVERIFIABLE, not failing,
                // and it must say so — the same vocabulary the export-binding section uses.
                //
                // A flat export missing from the descriptor is a real finding, but state it
                // no harder than it is: APIRegistry.getArgCount ends in an `@N` parse, so a
                // decorated stdcall name still binds — undeclared, its ABI is INFERRED from
                // the name rather than stated. An undecorated one has nothing to infer from:
                // a static import cannot be given a stub at all, and GetProcAddress hands out
                // a RET-0 stub for what may be a stdcall export.
                if (COM_METHOD_NAME.test(impl.name)) {
                    unverifiable++;
                    continue;
                }
                warnings.push({
                    type: 'incomplete_implementation',
                    functionName: impl.name,
                    message: `implemented but NOT DECLARED in ${path.basename(apiFile)} — nothing states its ABI, so the loader must infer one from the name or refuse the import`
                });
                continue;
            }

            // Check stack cleanup if it returns an object
            if (impl.hasReturnObject) {
                // Find stackCleanup value in the source code
                const content = fs.readFileSync(impl.filePath, 'utf-8');

                // Look for stackCleanup: N starting from the function name
                const funcIndex = content.indexOf(`'${impl.name}'`);
                if (funcIndex === -1) continue;

                const searchRegion = content.substring(funcIndex, funcIndex + 500);
                const scMatch = /stackCleanup:\s*(\d+)/.exec(searchRegion);

                if (scMatch) {
                    const actualCleanup = parseInt(scMatch[1], 10);
                    const expectedCleanup = expectedArgs * 4;
                    if (actualCleanup !== expectedCleanup) {
                        errors.push({
                            type: 'signature_mismatch',
                            functionName: impl.name,
                            message: `Stack cleanup mismatch! Descriptor says ${expectedArgs} args (${expectedCleanup} bytes), but implementation cleans up ${actualCleanup} bytes.`,
                            expected: expectedCleanup,
                            actual: actualCleanup
                        });
                    }
                }
            }
        }

        // Check vtable completeness for COM interfaces
        // This catches missing methods that would cause vtable slot misalignment
        for (const [interfaceName, methods] of Object.entries(apiInterfaces)) {
            const missingMethods: string[] = [];

            for (const method of methods) {
                const fullName = `${interfaceName}_${method.name}`;
                if (!implementedNames.has(fullName.toLowerCase())) {
                    missingMethods.push(method.name);
                }
            }

            if (missingMethods.length > 0) {
                // Group missing methods for cleaner error message
                const totalMethods = methods.length;
                const implementedCount = totalMethods - missingMethods.length;

                errors.push({
                    type: 'vtable_incomplete',
                    functionName: interfaceName,
                    message: `VTable incomplete: ${implementedCount}/${totalMethods} methods implemented. Missing: ${missingMethods.slice(0, 5).join(', ')}${missingMethods.length > 5 ? ` (+${missingMethods.length - 5} more)` : ''}. This causes vtable slot misalignment and stack corruption!`,
                    expected: totalMethods,
                    actual: implementedCount
                });
            }
        }
    }

    /**
     * Extract interface definitions with their methods in order
     */
    private extractApiInterfaces(apiFile: string, apiContent: string): Record<string, Array<{ name: string, argCount: number, slot: number }>> {
        const interfaces: Record<string, Array<{ name: string, argCount: number, slot: number }>> = {};
        const sourceFile = ts.createSourceFile(apiFile, apiContent, ts.ScriptTarget.Latest, true);

        const getStringLiteral = (node: ts.Node | undefined): string | null => {
            if (!node) return null;
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                return node.text;
            }
            return null;
        };

        const getNumberLiteral = (node: ts.Node | undefined): number | null => {
            if (!node) return null;
            if (ts.isNumericLiteral(node)) {
                return parseInt(node.text, 10);
            }
            return null;
        };

        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
                const typeName =
                    node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
                        ? node.type.typeName.text
                        : null;
                const varName = ts.isIdentifier(node.name) ? node.name.text : null;

                if (typeName === 'InterfaceDescriptor') {
                    let interfaceName = varName ?? '';
                    const methods: Array<{ name: string, argCount: number, slot: number }> = [];
                    let slot = 0;
                    // A spread of a *computed* method array (e.g. `...deviceMethods`, built via
                    // D3D9_DEVICE_METHOD_SPECS.map(...)) cannot be expanded statically here, so we
                    // cannot know the real method list → skip vtable-completeness for such an
                    // interface to avoid false positives. Only `...IUnknown.methods` is resolvable.
                    let unresolvableSpread = false;

                    for (const prop of node.initializer.properties) {
                        if (!ts.isPropertyAssignment(prop)) continue;
                        const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;

                        if (propName === 'name') {
                            const literal = getStringLiteral(prop.initializer);
                            if (literal) interfaceName = literal;
                        } else if (propName === 'methods' && ts.isArrayLiteralExpression(prop.initializer)) {
                            for (const element of prop.initializer.elements) {
                                // Handle spread elements. Only `...IUnknown.methods` (optionally
                                // `.map(...)`) is statically resolvable to the 3 IUnknown methods;
                                // a spread of any other (computed) array makes the method list
                                // unknown → mark unresolvable so we skip the completeness check.
                                if (ts.isSpreadElement(element)) {
                                    const exprText = element.expression.getText(sourceFile);
                                    if (/\bIUnknown\.methods\b/.test(exprText)) {
                                        methods.push({ name: 'QueryInterface', argCount: 3, slot: slot++ });
                                        methods.push({ name: 'AddRef', argCount: 1, slot: slot++ });
                                        methods.push({ name: 'Release', argCount: 1, slot: slot++ });
                                    } else {
                                        unresolvableSpread = true;
                                    }
                                    continue;
                                }

                                if (ts.isCallExpression(element)) {
                                    const callee = element.expression;
                                    const calleeName = ts.isIdentifier(callee) ? callee.text : null;
                                    if (calleeName === 'makeMethod' || calleeName === 'makeFunc') {
                                        const methodName = getStringLiteral(element.arguments[0]);
                                        const argCount = getNumberLiteral(element.arguments[1]);
                                        if (methodName && argCount !== null) {
                                            methods.push({ name: methodName, argCount, slot: slot++ });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (interfaceName && methods.length > 0 && !unresolvableSpread) {
                        interfaces[interfaceName] = methods;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return interfaces;
    }

    /**
     * Name → argCount for everything an `*.api.ts` declares. By default this covers
     * both `ModuleDescriptor.functions` (flat DLL exports) and `InterfaceDescriptor`
     * methods (keyed `Iface_Method`); `modulesOnly` restricts it to the DLL exports,
     * which is what a PE import table can actually name.
     */
    public extractApiFunctions(apiFile: string, apiContent: string, opts?: { modulesOnly?: boolean }): Record<string, number> {
        const apiFunctions: Record<string, number> = {};
        const sourceFile = ts.createSourceFile(apiFile, apiContent, ts.ScriptTarget.Latest, true);

        // Collect ordinal arrays like WSOCK_ORDINALS: Array<{ name: string; ordinal: number; argCount: number }>
        const ordinalArrays: Map<string, Array<{ name: string; argCount: number }>> = new Map();

        const collectOrdinalArrays = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
                const varName = ts.isIdentifier(node.name) ? node.name.text : null;
                if (varName) {
                    const ordinals: Array<{ name: string; argCount: number }> = [];
                    for (const el of node.initializer.elements) {
                        if (ts.isObjectLiteralExpression(el)) {
                            let name: string | null = null;
                            let argCount: number | null = null;
                            for (const prop of el.properties) {
                                if (!ts.isPropertyAssignment(prop)) continue;
                                const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
                                if (propName === 'name' && (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))) {
                                    name = prop.initializer.text;
                                } else if (propName === 'argCount' && ts.isNumericLiteral(prop.initializer)) {
                                    argCount = parseInt(prop.initializer.text, 10);
                                }
                            }
                            if (name && argCount !== null) {
                                ordinals.push({ name, argCount });
                            }
                        }
                    }
                    if (ordinals.length > 0) {
                        ordinalArrays.set(varName, ordinals);
                    }
                }
            }
            ts.forEachChild(node, collectOrdinalArrays);
        };
        collectOrdinalArrays(sourceFile);

        const addFunction = (name: string, argCount: number): void => {
            if (!name) return;
            if (typeof argCount !== 'number' || Number.isNaN(argCount)) return;
            apiFunctions[name] = argCount;
        };

        const addIUnknownMethods = (interfaceName: string): void => {
            if (!interfaceName) return;
            addFunction(`${interfaceName}_QueryInterface`, 3);
            addFunction(`${interfaceName}_AddRef`, 1);
            addFunction(`${interfaceName}_Release`, 1);
        };

        const getStringLiteral = (node: ts.Node | undefined): string | null => {
            if (!node) return null;
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                return node.text;
            }
            return null;
        };

        const getNumberLiteral = (node: ts.Node | undefined): number | null => {
            if (!node) return null;
            if (ts.isNumericLiteral(node)) {
                return parseInt(node.text, 10);
            }
            return null;
        };

        const extractMethodsFromArray = (interfaceName: string, node: ts.Node): void => {
            if (!ts.isArrayLiteralExpression(node)) return;
            for (const element of node.elements) {
                if (ts.isCallExpression(element)) {
                    const callee = element.expression;
                    const calleeName = ts.isIdentifier(callee) ? callee.text : null;
                    if (calleeName !== 'makeMethod' && calleeName !== 'makeFunc') continue;
                    const methodName = getStringLiteral(element.arguments[0]);
                    const argCount = getNumberLiteral(element.arguments[1]);
                    if (methodName && argCount !== null) {
                        addFunction(`${interfaceName}_${methodName}`, argCount);
                    }
                }
            }
        };

        const extractFunctionsFromArray = (node: ts.Node): void => {
            if (!ts.isArrayLiteralExpression(node)) return;
            for (const element of node.elements) {
                if (ts.isCallExpression(element)) {
                    const callee = element.expression;
                    const calleeName = ts.isIdentifier(callee) ? callee.text : null;
                    if (calleeName === 'makeFunc' || calleeName === 'makeMethod') {
                        const funcName = getStringLiteral(element.arguments[0]);
                        const argCount = getNumberLiteral(element.arguments[1]);
                        if (funcName && argCount !== null) {
                            addFunction(funcName, argCount);
                        }
                    } else if (calleeName && element.arguments.length >= 2) {
                        // Generic helper pattern: anyHelper("funcName", [...params], ...)
                        // The second arg is a params array — count its elements
                        const funcName = getStringLiteral(element.arguments[0]);
                        const paramsArg = element.arguments[1];
                        if (funcName && ts.isArrayLiteralExpression(paramsArg)) {
                            addFunction(funcName, paramsArg.elements.length);
                        } else if (funcName) {
                            const argCount = getNumberLiteral(element.arguments[1]);
                            if (argCount !== null) {
                                addFunction(funcName, argCount);
                            }
                        }
                    }
                    continue;
                }
                // Handle spread elements like ...WSOCK_ORDINALS.map(...)
                if (ts.isSpreadElement(element)) {
                    const spreadExpr = element.expression;
                    // Check for ARRAY.map(...) pattern
                    if (ts.isCallExpression(spreadExpr) &&
                        ts.isPropertyAccessExpression(spreadExpr.expression) &&
                        ts.isIdentifier(spreadExpr.expression.name) &&
                        spreadExpr.expression.name.text === 'map') {
                        const arrayExpr = spreadExpr.expression.expression;
                        if (ts.isIdentifier(arrayExpr)) {
                            const arrayName = arrayExpr.text;
                            const ordinalFuncs = ordinalArrays.get(arrayName);
                            if (ordinalFuncs) {
                                for (const { name, argCount } of ordinalFuncs) {
                                    addFunction(name, argCount);
                                }
                            }
                        }
                    }
                    continue;
                }
                if (!ts.isObjectLiteralExpression(element)) continue;
                let funcName: string | null = null;
                let paramCount: number | null = null;
                let ordinal: number | null = null;
                for (const prop of element.properties) {
                    if (!ts.isPropertyAssignment(prop)) continue;
                    const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
                    if (propName === 'name') {
                        funcName = getStringLiteral(prop.initializer);
                    } else if (propName === 'params' && ts.isArrayLiteralExpression(prop.initializer)) {
                        paramCount = prop.initializer.elements.length;
                    } else if (propName === 'ordinal') {
                        ordinal = getNumberLiteral(prop.initializer);
                    }
                }
                if (funcName && paramCount !== null) {
                    addFunction(funcName, paramCount);
                    // An `ordinal:` declaration makes the export reachable by ordinal ALONE —
                    // dsound/dplayx ship most of theirs nameless. The loader resolves ordinal N
                    // through this same descriptor, and modules register the handler under the
                    // `ord_N` spelling the import table hands them. One declaration, two legal
                    // names: register both, or every by-ordinal export reads as undeclared.
                    if (ordinal !== null) addFunction(`ord_${ordinal}`, paramCount);
                }
            }
        };

        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
                const typeName =
                    node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
                        ? node.type.typeName.text
                        : null;
                const varName = ts.isIdentifier(node.name) ? node.name.text : null;

                if (typeName === 'InterfaceDescriptor' && !opts?.modulesOnly) {
                    let interfaceName = varName ?? '';
                    for (const prop of node.initializer.properties) {
                        if (!ts.isPropertyAssignment(prop)) continue;
                        const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
                        if (propName === 'name') {
                            const literal = getStringLiteral(prop.initializer);
                            if (literal) interfaceName = literal;
                        } else if (propName === 'methods') {
                            extractMethodsFromArray(interfaceName, prop.initializer);
                        }
                    }
                    addIUnknownMethods(interfaceName);
                }

                if (typeName === 'ModuleDescriptor') {
                    for (const prop of node.initializer.properties) {
                        if (!ts.isPropertyAssignment(prop)) continue;
                        const propName = ts.isIdentifier(prop.name) ? prop.name.text : null;
                        if (propName === 'functions') {
                            extractFunctionsFromArray(prop.initializer);
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return apiFunctions;
    }

    /**
     * Validate all modules in a directory
     */
    validateAllModules(apiDir: string, modulesDir: string): ValidationResult[] {
        const results: ValidationResult[] = [];
        if (!fs.existsSync(modulesDir)) return results;

        const entries = fs.readdirSync(modulesDir, { withFileTypes: true });

        // Collect directory names to avoid processing re-export files (e.g., skip ddraw.ts if ddraw/ exists)
        const directoryNames = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));

        // Validate directory-based modules (e.g., ddraw/, kernel32/)
        const directories = entries.filter(e => e.isDirectory());
        for (const dir of directories) {
            const moduleName = dir.name;
            const implDir = path.join(modulesDir, moduleName);
            const apiFile = path.join(apiDir, `${moduleName}.api.ts`);
            results.push(this.validateModule(moduleName, fs.existsSync(apiFile) ? apiFile : null, implDir));
        }

        // Validate file-based modules (e.g., binkw32.ts, smackw32.ts, msvcrt.ts)
        // Skip re-export files (files with same name as a directory)
        const files = entries.filter(e =>
            e.isFile() &&
            e.name.endsWith('.ts') &&
            e.name !== 'index.ts' &&
            !directoryNames.has(e.name.replace('.ts', ''))  // Skip re-export files
        );
        for (const file of files) {
            const moduleName = file.name.replace('.ts', '');
            const implFile = path.join(modulesDir, file.name);
            const apiFile = path.join(apiDir, `${moduleName}.api.ts`);
            // Only validate if API file exists (skip internal helpers without API)
            if (fs.existsSync(apiFile)) {
                results.push(this.validateModule(moduleName, apiFile, implFile));
            }
        }

        return results;
    }
}

/**
 * CLI utility for signature validation
 */
export function validateSignatures(apiDir: string = 'src/worker/api', modulesDir: string = 'src/worker/modules'): void {
    const validator = new SignatureValidator();
    const results = validator.validateAllModules(apiDir, modulesDir);

    let totalErrors = 0;
    let totalWarnings = 0;

    console.log('Signature Validation Results:');
    console.log('='.repeat(50));

    for (const result of results) {
        const hasApi = fs.existsSync(path.join(apiDir, `${result.moduleName}.api.ts`));
        if (result.stats.totalFunctions === 0 && result.warnings.length === 0 && !hasApi) continue;

        console.log(`\nModule: ${result.moduleName}`);
        console.log(`Status: ${result.valid ? '✅ PASS' : '❌ FAIL'}`);
        // "in its own files" is load-bearing: a module that merges another's table
        // (imagehlp ← createDbgHelpExports) binds far more than this pass can see. The
        // export-binding section of validate-signatures is what counts the real table.
        console.log(`Functions: ${result.stats.totalFunctions} handlers in its own files`);

        if (result.errors.length > 0) {
            console.log('Errors:');
            for (const error of result.errors) {
                console.log(`  ❌ ${error.functionName}: ${error.message} (${result.moduleName})`);
                totalErrors++;
            }
        }

        if (result.warnings.length > 0) {
            console.log('Warnings:');
            for (const warning of result.warnings) {
                console.log(`  ⚠️  ${warning.functionName}: ${warning.message}`);
                totalWarnings++;
            }
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Summary: ${totalErrors} errors, ${totalWarnings} warnings`);

    if (totalErrors > 0) {
        process.exit(1);
    }
}
