import type { Operation } from "./Operation.js";

/**
 * Registry for available operations.
 */
export class OperationRegistry {
  private operations = new Map<string, Operation<Record<string, unknown>>>();

  /**
   * Register a new operation by name.
   */
  register(operation: Operation<Record<string, unknown>>): void {
    if (this.operations.has(operation.name)) {
      throw new Error(`Operation already registered: ${operation.name}`);
    }
    this.operations.set(operation.name, operation);
  }

  /**
   * Fetch an operation by name.
   */
  get(name: string): Operation<Record<string, unknown>> | undefined {
    return this.operations.get(name);
  }

  /**
   * List all registered operations.
   */
  list(): Operation<Record<string, unknown>>[] {
    return Array.from(this.operations.values());
  }
}
