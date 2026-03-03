import type { ServiceProvider } from "./ServiceProvider.js";

/**
 * Registry for service providers.
 */
export class ServiceRegistry {
  private services = new Map<string, ServiceProvider>();

  /**
   * Register a service by name.
   */
  register(service: ServiceProvider): void {
    if (this.services.has(service.name)) {
      throw new Error(`Service already registered: ${service.name}`);
    }
    this.services.set(service.name, service);
  }

  /**
   * Resolve a service by name.
   */
  get<T extends ServiceProvider>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service not found: ${name}`);
    }
    return service as T;
  }

  /**
   * List all registered services.
   */
  list(): ServiceProvider[] {
    return Array.from(this.services.values());
  }
}
