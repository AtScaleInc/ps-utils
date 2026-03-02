import type { OperationParams } from "./Operation.js";

/**
 * Supported parsed parameter value types.
 */
export type ParameterValue = string | number | boolean;

/**
 * Base class for a single operation parameter.
 * Subclasses can override parse/validate and provide defaults.
 */
export abstract class OperationParameter<T extends ParameterValue = ParameterValue> {
  abstract name: string;
  abstract description: string;
  abstract required: boolean;
  defaultValue?: T;

  /**
   * Convert raw CLI input into a typed value.
   */
  parse(raw: string): T {
    return raw as T;
  }

  /**
   * Optional validation hook for parsed values.
   */
  validate(_value: T): void {
    // Optional override for custom validation.
  }
}

/**
 * String parameter with identity parsing.
 */
export abstract class StringParameter extends OperationParameter<string> {
  parse(raw: string): string {
    return raw;
  }
}

/**
 * Number parameter with numeric parsing and validation.
 */
export abstract class NumberParameter extends OperationParameter<number> {
  parse(raw: string): number {
    const value = Number(raw);
    if (Number.isNaN(value)) {
      throw new Error(`Parameter ${this.name} must be a number.`);
    }
    return value;
  }
}

/**
 * Boolean parameter accepting only "true" or "false" strings.
 */
export abstract class BooleanParameter extends OperationParameter<boolean> {
  parse(raw: string): boolean {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    throw new Error(`Parameter ${this.name} must be true or false.`);
  }
}

/**
 * Collection of parameters for an operation, including parsing rules.
 */
export abstract class ParameterSet {
  abstract parameters: OperationParameter<ParameterValue>[];

  /**
   * Return the names of required parameters.
   */
  getRequiredNames(): string[] {
    return this.parameters.filter((p) => p.required).map((p) => p.name);
  }

  private getParameterNames(): Set<string> {
    return new Set(this.parameters.map((p) => p.name));
  }

  /**
   * Parse raw string inputs to typed values and apply defaults.
   * Throws when unknown keys are provided or validation fails.
   */
  parse(raw: OperationParams): Record<string, ParameterValue> {
    const known = this.getParameterNames();
    for (const key of Object.keys(raw)) {
      if (!known.has(key)) {
        throw new Error(`Unknown parameter: ${key}`);
      }
    }

    const parsed: Record<string, ParameterValue> = {};
    for (const param of this.parameters) {
      const rawValue = raw[param.name];
      if (rawValue === undefined) {
        if (param.defaultValue !== undefined) {
          parsed[param.name] = param.defaultValue;
          continue;
        }
        if (param.required) {
          throw new Error(`Missing required parameter: ${param.name}`);
        }
        continue;
      }

      const value = param.parse(rawValue);
      param.validate(value);
      parsed[param.name] = value;
    }

    return parsed;
  }
}
