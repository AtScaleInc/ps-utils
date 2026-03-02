import ejs from "ejs";
import { ServiceProvider } from "./ServiceProvider.js";
import crypto from 'node:crypto';

/**
 * EJS-backed templating service.
 */
export class EjsTemplateService extends ServiceProvider {
  name = "ejs";

  /**
   * Render an EJS template with the given data.
   */
  render(template: string, data: Record<string, unknown>): string {
    return ejs.render(template, {...data, crypto});
  }
}
