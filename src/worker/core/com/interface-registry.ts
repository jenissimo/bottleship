/**
 * Interface Registry - управление соответствием GUID -> Implementation Class
 *
 * Позволяет автоматически создавать COM-объекты по IID и поддерживать
 * QueryInterface для всех зарегистрированных интерфейсов.
 */

import { BaseComObject, ComObjectFactory } from './base-com-object';
import { Logger, LogCategory } from '../logger';
import { InterfaceDescriptor, ModuleDescriptor } from '../../api/types';

export interface InterfaceMapping {
    iid: string;
    className: string;
    moduleName: string;
    supportedInterfaces: string[]; // Additional IIDs this class supports
}

const IID_IUNKNOWN = "00000000-0000-0000-C000-000000000046";

export class InterfaceRegistry {
    private static instance: InterfaceRegistry;
    private mappings: Map<string, InterfaceMapping> = new Map();
    private classToMappings: Map<string, InterfaceMapping[]> = new Map();
    /**
     * Interface NAME -> descriptor. `InterfaceDescriptor.inherits` names a parent interface,
     * while `mappings` is keyed by IID; the two key spaces must not be mixed.
     */
    private descriptorsByName: Map<string, InterfaceDescriptor> = new Map();

    static getInstance(): InterfaceRegistry {
        if (!InterfaceRegistry.instance) {
            InterfaceRegistry.instance = new InterfaceRegistry();
        }
        return InterfaceRegistry.instance;
    }

    /**
     * Register an interface mapping
     */
    register(mapping: InterfaceMapping): void {
        const iid = this.normalizeIid(mapping.iid);
        this.mappings.set(iid, mapping);

        // Also index by class name for reverse lookups
        if (!this.classToMappings.has(mapping.className)) {
            this.classToMappings.set(mapping.className, []);
        }
        this.classToMappings.get(mapping.className)!.push(mapping);

        Logger.log(LogCategory.COM, `Registered interface ${mapping.iid} -> ${mapping.className}`);
    }

    /**
     * Register all interfaces from a module descriptor
     */
    registerFromModuleDescriptor(module: ModuleDescriptor): void {
        if (!module.interfaces) return;

        // Index the whole module before building any chain: a descriptor may name a parent
        // that appears later in the array.
        for (const iface of module.interfaces) {
            this.descriptorsByName.set(iface.name, iface);
        }

        for (const iface of module.interfaces) {
            if (!iface.iid) continue;

            // Build supported interfaces list (inheritance chain)
            const supportedInterfaces = this.buildSupportedInterfaces(iface);

            this.register({
                iid: iface.iid,
                className: iface.name,
                moduleName: module.name,
                supportedInterfaces
            });
        }
    }

    /**
     * Get mapping for an IID
     */
    getMapping(iid: string): InterfaceMapping | null {
        return this.mappings.get(this.normalizeIid(iid)) || null;
    }

    /**
     * Check if an IID is registered
     */
    isRegistered(iid: string): boolean {
        return this.mappings.has(this.normalizeIid(iid));
    }

    /**
     * Get all mappings for a class
     */
    getMappingsForClass(className: string): InterfaceMapping[] {
        return this.classToMappings.get(className) || [];
    }

    /**
     * Get all supported IIDs for a class
     */
    getSupportedIIDs(className: string): string[] {
        const mappings = this.getMappingsForClass(className);
        const iids = new Set<string>();

        for (const mapping of mappings) {
            iids.add(mapping.iid);
            mapping.supportedInterfaces.forEach(iid => iids.add(iid));
        }

        return Array.from(iids);
    }

    /**
     * Create a COM object for the given IID
     */
    createObject<T extends BaseComObject>(
        iid: string,
        vtableAddress: number,
        ...args: any[]
    ): T | null {
        const mapping = this.getMapping(iid);
        if (!mapping) {
            Logger.error(LogCategory.COM, `No mapping found for IID ${iid}`);
            return null;
        }

        return ComObjectFactory.create<T>(iid, vtableAddress, ...args);
    }

    /**
     * Get all registered IIDs
     */
    getRegisteredIIDs(): string[] {
        return Array.from(this.mappings.keys());
    }

    /**
     * Build the list of supported interfaces for an interface by walking `inherits` up to IUnknown.
     *
     * An ancestor IID is only listed when our table is a prefix-extension of that ancestor's
     * (same method at every one of its slots, and at least as many slots). Accepting an ancestor
     * IID means handing our vtable back for it: a shorter or reordered table turns the guest's
     * call through that IID into a read past the table's end — the vtable is exactly
     * methods.length * 4 bytes flush against stub code, so the "function pointer" is stub bytes.
     * An ancestor that fails the check, or that is not declared anywhere, stops the walk.
     */
    private buildSupportedInterfaces(iface: InterfaceDescriptor): string[] {
        const supported = new Set<string>([IID_IUNKNOWN]);
        const visited = new Set<string>([iface.name]);

        let parentName = iface.inherits;
        while (parentName && parentName !== "IUnknown" && !visited.has(parentName)) {
            visited.add(parentName);

            const parent = this.descriptorsByName.get(parentName);
            if (!parent) {
                Logger.warn(LogCategory.COM,
                    `Interface ${iface.name} inherits ${parentName}, which is not declared — inheritance chain stops here`);
                break;
            }

            if (!this.isPrefixExtensionOf(parent, iface)) {
                Logger.warn(LogCategory.COM,
                    `Interface ${iface.name} (${iface.methods.length} slots) is not a prefix-extension of ${parentName} ` +
                    `(${parent.methods.length} slots) — ${parentName} left unsupported`);
                break;
            }

            if (parent.iid) supported.add(parent.iid);
            parentName = parent.inherits;
        }

        return Array.from(supported);
    }

    /** True when `child`'s leading slots are exactly `ancestor`'s methods, in order. */
    private isPrefixExtensionOf(ancestor: InterfaceDescriptor, child: InterfaceDescriptor): boolean {
        if (child.methods.length < ancestor.methods.length) return false;

        for (let i = 0; i < ancestor.methods.length; i++) {
            if (child.methods[i].name !== ancestor.methods[i].name) return false;
        }

        return true;
    }

    private normalizeIid(iid: string): string {
        return iid.replace(/[{}]/g, "").toLowerCase();
    }

    /**
     * Validate that all interface relationships are consistent
     */
    validate(): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        for (const [iid, mapping] of this.mappings) {
            // Check that class exists (basic validation)
            if (!mapping.className) {
                errors.push(`Missing className for IID ${iid}`);
            }

            // Check inheritance consistency
            for (const supportedIid of mapping.supportedInterfaces) {
                if (!this.isRegistered(supportedIid)) {
                    errors.push(`Interface ${iid} supports unregistered interface ${supportedIid}`);
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }
}

/**
 * Helper function to register standard DirectX interfaces
 */
export function registerStandardDirectXInterfaces(): void {
    const registry = InterfaceRegistry.getInstance();

    // IUnknown is always supported by all COM objects
    registry.register({
        iid: "00000000-0000-0000-C000-000000000046", // IUnknown
        className: "BaseComObject",
        moduleName: "com",
        supportedInterfaces: []
    });
    
    // DirectDraw interfaces
    registry.register({
        iid: "15e65ec0-3b9c-11d2-b92f-00c04fc2c602", // IDirectDraw7
        className: "IDirectDraw7",
        moduleName: "ddraw",
        supportedInterfaces: ["00000000-0000-0000-C000-000000000046"] // IUnknown
    });
    
    // DirectDraw CLSID -> IDirectDraw7 IID mapping
    // CLSID {d7b70ee0-4340-11cf-b063-0020afc2cd35} creates IDirectDraw7
    // Also support older IID {9c59509a-39bd-11d1-8c4a-00c04fd930c5} (IDirectDraw)
    registry.register({
        iid: "9c59509a-39bd-11d1-8c4a-00c04fd930c5", // IDirectDraw (older version)
        className: "IDirectDraw7", // Use IDirectDraw7 implementation
        moduleName: "ddraw",
        supportedInterfaces: ["00000000-0000-0000-C000-000000000046", "15e65ec0-3b9c-11d2-b92f-00c04fc2c602"]
    });
    
    // DirectInput interfaces
    registry.register({
        iid: "89521360-AA8A-11CF-BFC7-444553540000", // IDirectInputA
        className: "IDirectInputA",
        moduleName: "dinput",
        supportedInterfaces: ["00000000-0000-0000-C000-000000000046"] // IUnknown
    });
}
