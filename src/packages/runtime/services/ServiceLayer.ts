import { ServiceRepr } from "./ServiceRepr";
import { Error } from "@open-pioneer/core";
import { ErrorId } from "../errors";
import { UIDependency, verifyDependencies } from "./verifyDependencies";
import { PackageRepr } from "./PackageRepr";
import { ReadonlyServiceLookup, ServiceLookupResult } from "./ServiceLookup";
import { InterfaceSpec, renderInterfaceSpec } from "./InterfaceSpec";

export type DynamicLookupResult = ServiceLookupResult | UndeclaredDependency;

export interface UndeclaredDependency {
    type: "undeclared";
}

interface DependencyDeclarations {
    unqualified: boolean;
    qualifiers: Set<string>;
}

export class ServiceLayer {
    readonly serviceLookup: ReadonlyServiceLookup;

    // Package name --> Interface name --> Declarations
    private declaredDependencies;
    private allServices: readonly ServiceRepr[];
    private state: "not-started" | "started" | "destroyed" = "not-started";

    constructor(packages: readonly PackageRepr[]) {
        this.allServices = packages.map((pkg) => pkg.services).flat();
        this.serviceLookup = verifyDependencies({
            services: this.allServices,
            uiDependencies: packages
                .map((pkg) =>
                    pkg.uiReferences.map<UIDependency>((dep) => {
                        return {
                            packageName: pkg.name,
                            ...dep
                        };
                    })
                )
                .flat()
        });
        this.declaredDependencies = buildDependencyIndex(packages);
    }

    destroy() {
        this.allServices.forEach((value) => {
            this.destroyService(value);
        });
        this.state = "destroyed";
    }

    start() {
        if (this.state !== "not-started") {
            throw new Error(ErrorId.INTERNAL, "Service layer was already started.");
        }

        this.allServices.forEach((value) => {
            this.createService(value);
        });
        this.state = "started";
    }

    /**
     * Returns a service implementing the given interface.
     * Checks that the given package actually declared a dependency on that interface
     * to enforce coding guidelines.
     *
     * @param packageName the name of the package requesting the import
     * @param spec the interface specifier
     *
     * @throws if the service layer is not in 'started' state or if no service implements the interface.
     */
    getService(packageName: string, spec: InterfaceSpec): DynamicLookupResult {
        if (this.state !== "started") {
            throw new Error(ErrorId.INTERNAL, "Service layer is not started.");
        }

        if (!this.isDeclaredDependency(packageName, spec)) {
            return { type: "undeclared" };
        }

        return this.serviceLookup.lookup(spec);
    }

    /**
     * Initializes the given service and its dependencies.
     * Dependencies are initialized before the service that requires them.
     */
    private createService(service: ServiceRepr) {
        if (service.state === "constructed") {
            const instance = service.getInstanceOrThrow();
            service.addRef();
            return instance;
        }
        if (service.state === "constructing") {
            throw new Error(ErrorId.INTERNAL, "Cycle during service construction.");
        }
        if (service.state !== "not-constructed") {
            throw new Error(ErrorId.INTERNAL, "Invalid service state.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instances: Record<string, any> = {};

        // Sets state to 'constructing' to detect cycles
        service.beforeCreate();

        // Initialize dependencies recursively before creating the current service.
        service.dependencies.forEach((d) => {
            const serviceRef = this.mustGet(d);
            const instance = this.createService(serviceRef);
            instances[d.referenceName] = instance;
        });

        // Sets state to 'constructed' to finish the state transition, useCount is 1.
        return service.create({ references: instances, properties: service.properties });
    }

    /**
     * Destroys the given service and its dependencies.
     * The dependencies are destroyed after the service.
     */
    private destroyService(service: ServiceRepr) {
        if (service.state === "destroyed") {
            return;
        }

        // Destroy the service before its dependencies (reverse order
        // compared to construction).
        if (service.removeRef() <= 0) {
            service.destroy();
        }

        service.dependencies.forEach((d) => {
            const lookupResult = this.serviceLookup.lookup(d);
            if (lookupResult.type === "found") {
                this.destroyService(lookupResult.service);
            }
        });
    }

    private isDeclaredDependency(packageName: string, spec: InterfaceSpec) {
        const packageEntry = this.declaredDependencies.get(packageName);
        if (!packageEntry) {
            return false;
        }
        const interfaceEntry = packageEntry.get(spec.interfaceName);
        if (!interfaceEntry) {
            return false;
        }
        if (spec.qualifier == null) {
            return interfaceEntry.unqualified;
        }
        return interfaceEntry.qualifiers.has(spec.qualifier);
    }

    /**
     * Called to retrieve a service implementation for which we know that it exists (due to prior validation).
     */
    private mustGet(spec: InterfaceSpec) {
        const result = this.serviceLookup.lookup(spec);
        if (result.type !== "found") {
            throw new Error(
                ErrorId.INTERNAL,
                `Failed to find service implementing interface ${renderInterfaceSpec(
                    spec
                )}: result type '${result.type}'.`
            );
        }
        return result.service;
    }
}

function buildDependencyIndex(packages: readonly PackageRepr[]) {
    // Register declared UI dependencies.
    // This is needed as a lookup structure to that dynamic service lookups
    // can be validated at runtime.
    const index = new Map<string, Map<string, DependencyDeclarations>>();
    for (const pkg of packages) {
        const packageName = pkg.name;
        const packageEntry = new Map<string, DependencyDeclarations>();
        for (const uiReference of pkg.uiReferences) {
            let interfaceEntry = packageEntry.get(uiReference.interfaceName);
            if (!interfaceEntry) {
                interfaceEntry = {
                    unqualified: false,
                    qualifiers: new Set<string>()
                };
                packageEntry.set(uiReference.interfaceName, interfaceEntry);
            }

            if (uiReference.qualifier == null) {
                interfaceEntry.unqualified = true;
            } else {
                interfaceEntry.qualifiers.add(uiReference.qualifier);
            }
        }
        index.set(packageName, packageEntry);
    }
    return index;
}
