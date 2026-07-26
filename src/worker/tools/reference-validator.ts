/**
 * Reference Signature Validator
 * 
 * Validates that API descriptors match reference signatures from header files.
 * Supports both COM interfaces (DirectX) and regular functions (MSS32, etc.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as ts from 'typescript';
import { InterfaceDescriptor, FunctionDescriptor, ModuleDescriptor } from '../api/types';

type CallingConvention = "stdcall" | "cdecl" | "thiscall";

const IUNKNOWN_SLOTS = ["queryinterface", "addref", "release"];

function startsWithIUnknown(methods: FunctionDescriptor[]): boolean {
    return methods.length >= 3
        && IUNKNOWN_SLOTS.every((n, i) => methods[i].name.toLowerCase() === n);
}

/**
 * Trailing slots we declare on purpose beyond what the reference lists, with the reason.
 *
 * These are reported as warnings rather than errors so a genuine misalignment still fails the
 * run. Only TRAILING additions are ever legitimate: a slot inserted in the middle shifts every
 * later slot and is always a bug. Each entry needs a reason a reviewer can check, and anything
 * not listed here stays an error.
 */
const INTENTIONAL_EXTRA_METHODS: Record<string, { methods: string[]; reason: string }> = {
    IDirectDrawSurface: {
        methods: ["GetDDInterface", "PageLock", "PageUnlock", "SetSurfaceDesc"],
        reason: "this table is also handed out for IID_IDirectDrawSurface2/3, whose vtables extend "
            + "v1 by strict append and share its DDSURFACEDESC marshalling — the reference "
            + "describes v1 alone",
    },
};

interface MethodSignature {
    name: string;
    cParams: number;  // Number of parameters in C++ (excluding this)
    vtableIndex: number;
    signature: string;
}

interface InterfaceSignature {
    interface: string;
    iid?: string;
    methods: MethodSignature[];
}

interface FunctionSignature {
    name: string;
    argCount: number;
    signature: string;
    returnType?: string;
    note?: string;
}

interface ValidationError {
    interface?: string;
    function?: string;
    method?: string;
    type: 'argCount_mismatch' | 'calling_convention_mismatch' | 'missing_method' | 'extra_method' | 'vtable_order' | 'iid_mismatch' | 'missing_function' | 'extra_function' | 'extraction_degraded';
    message: string;
    expected?: any;
    actual?: any;
}

interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
    stats: {
        interfacesChecked?: number;
        methodsChecked?: number;
        functionsChecked?: number;
        errorsFound: number;
        warningsFound: number;
    };
}

export class ReferenceSignatureValidator {
    private interfaceSignatures: Map<string, InterfaceSignature> = new Map();
    private functionSignatures: Map<string, FunctionSignature[]> = new Map(); // module -> functions
    private referenceDir: string;

    constructor(referenceDir: string = path.join(process.cwd(), 'tools/reference')) {
        this.referenceDir = referenceDir;
        this.loadReferenceSignatures();
    }

    /**
     * Load reference signatures from .sig.json files
     */
    private loadReferenceSignatures(): void {
        // Load DirectX interfaces
        const directxDir = path.join(this.referenceDir, 'directx');
        if (fs.existsSync(directxDir)) {
            const files = fs.readdirSync(directxDir).filter(f => f.endsWith('.sig.json'));
            for (const file of files) {
                const filePath = path.join(directxDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(content);
                
                if (Array.isArray(data.interfaces)) {
                    for (const iface of data.interfaces) {
                        this.interfaceSignatures.set(iface.interface, iface);
                    }
                }
            }
        }

        // Load function signatures (MSS32, win32, etc.)
        const modules = fs.readdirSync(this.referenceDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name !== 'directx');
        
        for (const moduleDir of modules) {
            const modulePath = path.join(this.referenceDir, moduleDir.name);
            
            // Check if this is a category directory (like win32) with subdirectories
            const subdirs = fs.readdirSync(modulePath, { withFileTypes: true })
                .filter(d => d.isDirectory());
            
            if (subdirs.length > 0) {
                // This is a category directory (e.g., win32), search in subdirectories
                for (const subdir of subdirs) {
                    const subdirPath = path.join(modulePath, subdir.name);
                    const sigFiles = fs.readdirSync(subdirPath).filter(f => f.endsWith('.sig.json'));
                    
                    for (const sigFile of sigFiles) {
                        const filePath = path.join(subdirPath, sigFile);
                        const content = fs.readFileSync(filePath, 'utf-8');
                        const data = JSON.parse(content);
                        
                        if (Array.isArray(data.functions) && data.module) {
                            // Use module name from JSON, not directory name
                            this.functionSignatures.set(data.module, data.functions);
                        }
                    }
                }
            } else {
                // This is a direct module directory (e.g., mss32)
                const sigFiles = fs.readdirSync(modulePath).filter(f => f.endsWith('.sig.json'));
                
                for (const sigFile of sigFiles) {
                    const filePath = path.join(modulePath, sigFile);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const data = JSON.parse(content);
                    
                    if (Array.isArray(data.functions)) {
                        // Use module name from JSON if available, otherwise use directory name
                        const moduleName = data.module || moduleDir.name;
                        this.functionSignatures.set(moduleName, data.functions);
                    }
                }
            }
        }
    }

    private normalizeFunctionName(name: string): string {
        let normalized = name.trim();
        normalized = normalized.replace(/^[_@]+/, "");
        normalized = normalized.replace(/@\d+$/, "");
        return normalized;
    }

    private isVarArgsSignature(signature: string, returnType?: string): boolean {
        const sig = signature ?? "";
        const ret = returnType ?? "";
        return sig.includes("...") || sig.includes("WINAPIV") || ret.includes("WINAPIV") || /__cdecl|cdecl/i.test(sig);
    }

    private isVoidParamsSignature(signature: string): boolean {
        return /\(\s*void\s*\)/i.test(signature) || /\(\s*\)/.test(signature);
    }

    private getExpectedCallingConvention(ref: FunctionSignature): CallingConvention | null {
        if (this.isVarArgsSignature(ref.signature, ref.returnType)) return "cdecl";
        if (/^_.*@\d+$/.test(ref.name) || /^@.*@\d+$/.test(ref.name)) return "stdcall";
        if (/^_/.test(ref.name)) return "cdecl";
        return null;
    }

    /**
     * Extract interface descriptors by importing the API module.
     *
     * This is the accurate path: the descriptor arrays are evaluated exactly as the vtable
     * builder will see them, so any composition form (spread of a local method array, a
     * `specs.map(makeMethod)`, an overrides lookup) is resolved for free. The AST path below
     * has to re-implement a slice of TypeScript and silently yields ZERO methods for any form
     * it does not recognise — which reads as "the whole interface is missing" downstream.
     *
     * Returns null when the module cannot be evaluated standalone (e.g. an import cycle with a
     * module-eval side effect), leaving the caller to fall back and flag the degradation.
     */
    private async extractInterfacesViaImport(filePath: string): Promise<Map<string, InterfaceDescriptor> | null> {
        let mod: Record<string, unknown>;
        try {
            mod = await import(pathToFileURL(filePath).href) as Record<string, unknown>;
        } catch {
            return null;
        }

        const interfaces = new Map<string, InterfaceDescriptor>();
        for (const value of Object.values(mod)) {
            const iface = value as InterfaceDescriptor | undefined;
            if (!iface || typeof iface !== 'object') continue;
            if (typeof iface.name !== 'string' || !Array.isArray(iface.methods)) continue;
            if (iface.methods.some(m => !m || typeof m.name !== 'string' || !Array.isArray(m.params))) continue;
            // Reference vtableIndex is relative to the interface's OWN methods, so drop the
            // inherited IUnknown triad to put both sides on the same numbering.
            const methods = startsWithIUnknown(iface.methods) ? iface.methods.slice(3) : iface.methods;
            interfaces.set(iface.name, { ...iface, methods });
        }
        return interfaces;
    }

    /**
     * Extract interface descriptors from API file using TypeScript AST
     */
    private extractInterfacesFromApiFile(filePath: string): Map<string, InterfaceDescriptor> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true
        );
        
        const interfaces: Map<string, InterfaceDescriptor> = new Map();
        
        const visit = (node: ts.Node) => {
            // Look for: export const IDirect3D7: InterfaceDescriptor = { ... }
            if (ts.isVariableStatement(node)) {
                const declarations = node.declarationList.declarations;
                if (declarations.length > 0) {
                    const decl = declarations[0];
                    if (decl.name && ts.isIdentifier(decl.name)) {
                        const varName = decl.name.text;
                        const typeNode = decl.type;
                        
                        // Check if it's InterfaceDescriptor type
                        if (typeNode && typeNode.kind === ts.SyntaxKind.TypeReference) {
                            const typeRef = typeNode as ts.TypeReferenceNode;
                            if (typeRef.typeName && ts.isIdentifier(typeRef.typeName) && 
                                typeRef.typeName.text === 'InterfaceDescriptor') {
                                // Extract the object literal
                                if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                                    const iface = this.extractInterfaceFromObject(decl.initializer, varName);
                                    if (iface) {
                                        interfaces.set(iface.name, iface);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            ts.forEachChild(node, visit);
        };
        
        visit(sourceFile);
        return interfaces;
    }

    /**
     * Extract module descriptor from API file
     */
    private extractModuleFromApiFile(filePath: string): ModuleDescriptor | null {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true
        );
        
        const visit = (node: ts.Node) => {
            // Look for: export const mss32Module: ModuleDescriptor = { ... }
            if (ts.isVariableStatement(node)) {
                const declarations = node.declarationList.declarations;
                if (declarations.length > 0) {
                    const decl = declarations[0];
                    if (decl.name && ts.isIdentifier(decl.name)) {
                        const varName = decl.name.text;
                        const typeNode = decl.type;
                        
                        // Check if it's ModuleDescriptor type
                        if (typeNode && typeNode.kind === ts.SyntaxKind.TypeReference) {
                            const typeRef = typeNode as ts.TypeReferenceNode;
                            if (typeRef.typeName && ts.isIdentifier(typeRef.typeName) && 
                                typeRef.typeName.text === 'ModuleDescriptor') {
                                // Extract the object literal
                                if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                                    return this.extractModuleFromObject(decl.initializer, varName);
                                }
                            }
                        }
                    }
                }
            }
            
            let result: ModuleDescriptor | null = null;
            ts.forEachChild(node, (child) => {
                const childResult = visit(child);
                if (childResult) result = childResult;
            });
            return result;
        };
        
        return visit(sourceFile);
    }
    
    /**
     * Extract interface from object literal expression
     */
    private extractInterfaceFromObject(
        obj: ts.ObjectLiteralExpression,
        varName: string
    ): InterfaceDescriptor | null {
        let name = '';
        let iid: string | undefined;
        const methods: Array<{ name: string; argCount: number }> = [];
        
        for (const prop of obj.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
                continue;
            }
            
            const propName = prop.name.text;
            
            if (propName === 'name' && ts.isStringLiteral(prop.initializer)) {
                name = prop.initializer.text;
            } else if (propName === 'iid' && ts.isStringLiteral(prop.initializer)) {
                iid = prop.initializer.text;
            } else if (propName === 'methods' && ts.isArrayLiteralExpression(prop.initializer)) {
                // Extract methods from array
                for (const element of prop.initializer.elements) {
                    if (ts.isCallExpression(element)) {
                        const methodInfo = this.extractMethodFromCall(element);
                        if (methodInfo) {
                            methods.push(methodInfo);
                        }
                    } else if (ts.isSpreadElement(element) && 
                               ts.isCallExpression(element.expression) &&
                               ts.isPropertyAccessExpression(element.expression.expression) &&
                               element.expression.expression.name.text === 'map') {
                        // Skip IUnknown methods spread: ...IUnknown.methods.map(...)
                        continue;
                    }
                }
            }
        }
        
        if (!name) {
            return null;
        }
        
        return {
            name,
            iid,
            methods: methods.map(m => ({
                name: m.name,
                params: Array(m.argCount).fill(0).map((_, i) => ({
                    name: i === 0 ? 'this' : `arg${i}`,
                    type: i === 0 ? 'ptr' : 'u32'
                })),
                returnType: 'u32',
                callingConvention: 'stdcall'
            }))
        } as InterfaceDescriptor;
    }

    /**
     * Extract module from object literal expression
     */
    private extractModuleFromObject(
        obj: ts.ObjectLiteralExpression,
        varName: string
    ): ModuleDescriptor | null {
        let name = '';
        const functions: Array<{ name: string; argCount: number; callingConvention?: CallingConvention }> = [];
        
        for (const prop of obj.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
                continue;
            }
            
            const propName = prop.name.text;
            
            if (propName === 'name' && ts.isStringLiteral(prop.initializer)) {
                name = prop.initializer.text;
            } else if (propName === 'functions' && ts.isArrayLiteralExpression(prop.initializer)) {
                // Extract functions from array
                for (const element of prop.initializer.elements) {
                    if (ts.isCallExpression(element)) {
                        const funcInfo = this.extractFunctionFromCall(element);
                        if (funcInfo) {
                            functions.push(funcInfo);
                        }
                    } else if (ts.isObjectLiteralExpression(element)) {
                        const funcInfo = this.extractFunctionFromObjectLiteral(element);
                        if (funcInfo) {
                            functions.push(funcInfo);
                        }
                    }
                }
            }
        }
        
        if (!name) {
            return null;
        }
        
        return {
            name,
            functions: functions.map(f => ({
                name: f.name,
                params: Array(f.argCount).fill(0).map((_, i) => ({
                    name: `arg${i}`,
                    type: 'u32'
                })),
                returnType: 'u32',
                callingConvention: f.callingConvention ?? 'stdcall'
            }))
        } as ModuleDescriptor;
    }
    
    /**
     * Extract method name and argCount from makeMethod call
     */
    private extractMethodFromCall(call: ts.CallExpression): { name: string; argCount: number } | null {
        if (!ts.isIdentifier(call.expression) || call.expression.text !== 'makeMethod') {
            return null;
        }
        
        if (call.arguments.length < 2) {
            return null;
        }
        
        const nameArg = call.arguments[0];
        const countArg = call.arguments[1];
        
        if (!ts.isStringLiteral(nameArg) || !ts.isNumericLiteral(countArg)) {
            return null;
        }
        
        return {
            name: nameArg.text,
            argCount: parseInt(countArg.text, 10)
        };
    }

    /**
     * Extract function name and argCount from makeFunc call
     */
    private extractFunctionFromCall(call: ts.CallExpression): { name: string; argCount: number; callingConvention?: CallingConvention } | null {
        if (!ts.isIdentifier(call.expression) || (call.expression.text !== 'makeFunc' && call.expression.text !== 'makeMethod')) {
            return null;
        }
        
        if (call.arguments.length < 2) {
            return null;
        }
        
        const nameArg = call.arguments[0];
        const countArg = call.arguments[1];
        
        if (!ts.isStringLiteral(nameArg) || !ts.isNumericLiteral(countArg)) {
            return null;
        }

        let callingConvention: CallingConvention | undefined;
        const overridesArg = call.arguments[2];
        if (overridesArg && ts.isObjectLiteralExpression(overridesArg)) {
            for (const prop of overridesArg.properties) {
                if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
                    continue;
                }
                if (prop.name.text === 'callingConvention' && ts.isStringLiteral(prop.initializer)) {
                    callingConvention = prop.initializer.text as CallingConvention;
                }
            }
        }

        return {
            name: nameArg.text,
            argCount: parseInt(countArg.text, 10),
            callingConvention
        };
    }

    private extractFunctionFromObjectLiteral(obj: ts.ObjectLiteralExpression): { name: string; argCount: number; callingConvention?: CallingConvention } | null {
        let name: string | null = null;
        let argCount: number | null = null;
        let callingConvention: CallingConvention | undefined;

        for (const prop of obj.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
                continue;
            }
            const propName = prop.name.text;
            if (propName === 'name' && ts.isStringLiteral(prop.initializer)) {
                name = prop.initializer.text;
            } else if (propName === 'params' && ts.isArrayLiteralExpression(prop.initializer)) {
                argCount = prop.initializer.elements.length;
            } else if (propName === 'callingConvention' && ts.isStringLiteral(prop.initializer)) {
                callingConvention = prop.initializer.text as CallingConvention;
            }
        }

        if (!name || argCount === null) {
            return null;
        }

        return { name, argCount, callingConvention };
    }

    /**
     * Validate interface descriptor against reference signature
     */
    private validateInterface(
        descriptor: InterfaceDescriptor,
        reference: InterfaceSignature
    ): { errors: ValidationError[]; warnings: ValidationError[] } {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];
        
        // Check IID
        if (reference.iid && descriptor.iid) {
            if (reference.iid.toLowerCase() !== descriptor.iid.toLowerCase()) {
                errors.push({
                    interface: descriptor.name,
                    type: 'iid_mismatch',
                    message: `IID mismatch for ${descriptor.name}`,
                    expected: reference.iid,
                    actual: descriptor.iid
                });
            }
        }
        
        // Build method maps
        const refMethods = new Map<string, MethodSignature>();
        for (const method of reference.methods) {
            refMethods.set(method.name, method);
        }

        const descMethodsArray = descriptor.methods.map(m => ({
            name: m.name,
            argCount: m.params.length
        }));
        const descMethodsByName = new Map(descMethodsArray.map(m => [m.name, m] as const));
        
        // Check for missing methods
        for (const [name, refMethod] of refMethods) {
            if (!descMethodsByName.has(name)) {
                errors.push({
                    interface: descriptor.name,
                    method: name,
                    type: 'missing_method',
                    message: `Method ${name} is missing in ${descriptor.name}`,
                    expected: refMethod
                });
            }
        }
        
        // Check for extra methods (critical for vtable alignment)
        const declaredExtras = INTENTIONAL_EXTRA_METHODS[descriptor.name];
        for (const descMethod of descMethodsArray) {
            const name = descMethod.name;
            if (refMethods.has(name)) continue;
            if (declaredExtras?.methods.includes(name)) {
                warnings.push({
                    interface: descriptor.name,
                    method: name,
                    type: 'extra_method',
                    message: `${descriptor.name}.${name} is a declared deviation: ${declaredExtras.reason}`,
                });
                continue;
            }
            errors.push({
                interface: descriptor.name,
                method: name,
                type: 'extra_method',
                message: `Method ${name} exists in ${descriptor.name} but not in reference (vtable misalignment!)`,
                actual: descMethod
            });
        }
        
        // Check argCount and vtable order for existing methods, by index.
        for (let i = 0; i < descMethodsArray.length; i++) {
            const descMethod = descMethodsArray[i];
            const refMethod = refMethods.get(descMethod.name);
            if (!refMethod) continue;

            // argCount should be cParams + 1 (this pointer)
            const expectedArgCount = refMethod.cParams + 1;
            if (descMethod.argCount !== expectedArgCount) {
                errors.push({
                    interface: descriptor.name,
                    method: descMethod.name,
                    type: 'argCount_mismatch',
                    message: `argCount mismatch for ${descriptor.name}::${descMethod.name}: expected ${expectedArgCount} (${refMethod.cParams} params + this), got ${descMethod.argCount}`,
                    expected: expectedArgCount,
                    actual: descMethod.argCount
                });
            }

            // vtable index mismatch
            if (refMethod.vtableIndex !== i) {
                errors.push({
                    interface: descriptor.name,
                    method: descMethod.name,
                    type: 'vtable_order',
                    message: `VTable order mismatch for ${descriptor.name}::${descMethod.name}: expected index ${refMethod.vtableIndex}, got ${i}`,
                    expected: refMethod.vtableIndex,
                    actual: i
                });
            }
        }
        
        return { errors, warnings };
    }

    /**
     * Validate module functions against reference signatures
     */
    private validateFunctions(
        descriptor: ModuleDescriptor,
        references: FunctionSignature[]
    ): ValidationError[] {
        const errors: ValidationError[] = [];
        
        // Build maps
        const refFunctions = new Map<string, FunctionSignature[]>();
        for (const func of references) {
            const normalized = this.normalizeFunctionName(func.name).toLowerCase();
            const list = refFunctions.get(normalized);
            if (list) {
                list.push(func);
            } else {
                refFunctions.set(normalized, [func]);
            }
        }

        const descFunctions = descriptor.functions.map(f => ({
            name: f.name,
            argCount: f.params.length,
            callingConvention: f.callingConvention as CallingConvention | undefined
        }));
        const descFunctionsByName = new Map(descFunctions.map(f => [this.normalizeFunctionName(f.name).toLowerCase(), f] as const));
        
        // Check for missing functions
        for (const [name] of refFunctions) {
            if (!descFunctionsByName.has(name)) {
                errors.push({
                    function: name,
                    type: 'missing_function',
                    message: `Function ${name} is missing in ${descriptor.name}`
                });
            }
        }
        
        // Check for extra functions (warnings, not errors)
        // (Some modules may have extra functions not in reference)
        
        // Check argCount for existing functions
        for (const descFunc of descFunctions) {
            const normalized = this.normalizeFunctionName(descFunc.name).toLowerCase();
            const refCandidates = refFunctions.get(normalized);
            if (!refCandidates || refCandidates.length === 0) continue;

            const exactArgMatch = refCandidates.find(ref => ref.argCount === descFunc.argCount);
            const refFunc = exactArgMatch ?? refCandidates[0];
            const isVarArgs = this.isVarArgsSignature(refFunc.signature, refFunc.returnType);

            const expectedArgCount = this.isVoidParamsSignature(refFunc.signature) ? 0 : refFunc.argCount;
            if (!isVarArgs && descFunc.argCount !== expectedArgCount) {
                errors.push({
                    function: descFunc.name,
                    type: 'argCount_mismatch',
                    message: `argCount mismatch for ${descFunc.name}: expected ${expectedArgCount}, got ${descFunc.argCount}`,
                    expected: expectedArgCount,
                    actual: descFunc.argCount
                });
            }

            const expectedCallingConvention = this.getExpectedCallingConvention(refFunc);
            if (expectedCallingConvention && descFunc.callingConvention && descFunc.callingConvention !== expectedCallingConvention) {
                errors.push({
                    function: descFunc.name,
                    type: 'calling_convention_mismatch',
                    message: `callingConvention mismatch for ${descFunc.name}: expected ${expectedCallingConvention}, got ${descFunc.callingConvention}`,
                    expected: expectedCallingConvention,
                    actual: descFunc.callingConvention
                });
            }
        }
        
        return errors;
    }

    /**
     * Validate API file against reference signatures
     */
    async validate(apiFilePath: string): Promise<ValidationResult> {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        // Try to extract interfaces first (DirectX). Prefer evaluating the module; only fall
        // back to the lossy AST reader when it cannot load, and say so — a file silently
        // degrading to the fallback is how phantom "missing method" reports get manufactured.
        let interfaces = await this.extractInterfacesViaImport(apiFilePath);
        if (!interfaces) {
            interfaces = this.extractInterfacesFromApiFile(apiFilePath);
            if (interfaces.size > 0) {
                warnings.push({
                    type: 'extraction_degraded',
                    message: `${path.basename(apiFilePath)}: module could not be imported; fell back to AST extraction. `
                        + `Method lists composed via spreads are read as empty, so "missing method" errors from this file may be phantom.`
                });
            }
        }
        let interfacesChecked = 0;
        let methodsChecked = 0;
        
        for (const [name, descriptor] of interfaces) {
            const reference = this.interfaceSignatures.get(name);
            
            if (!reference) {
                warnings.push({
                    interface: name,
                    type: 'missing_method',
                    message: `No reference signature found for ${name} - skipping validation`
                });
                continue;
            }
            
            interfacesChecked++;
            methodsChecked += descriptor.methods.length;
            
            const interfaceResult = this.validateInterface(descriptor, reference);
            errors.push(...interfaceResult.errors);
            warnings.push(...interfaceResult.warnings);
        }

        // Try to extract module (functions)
        const module = this.extractModuleFromApiFile(apiFilePath);
        let functionsChecked = 0;
        
        if (module) {
            const references = this.functionSignatures.get(module.name);
            
            if (references) {
                functionsChecked = module.functions.length;
                const functionErrors = this.validateFunctions(module, references);
                errors.push(...functionErrors);
            } else {
                // Only show warning if module has functions and no interfaces were found
                // (modules with only interfaces shouldn't show this warning)
                if (module.functions.length > 0 || interfaces.size === 0) {
                    warnings.push({
                        function: module.name,
                        type: 'missing_function',
                        message: `No reference signatures found for module ${module.name} - skipping validation`
                    });
                }
            }
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings,
            stats: {
                interfacesChecked,
                methodsChecked,
                functionsChecked,
                errorsFound: errors.length,
                warningsFound: warnings.length
            }
        };
    }
}

/**
 * Main validation function
 */
export function validateReferenceSignatures(
    apiFilePath: string,
    referenceDir: string = path.join(process.cwd(), 'tools/reference')
): Promise<ValidationResult> {
    const validator = new ReferenceSignatureValidator(referenceDir);
    return validator.validate(apiFilePath);
}
