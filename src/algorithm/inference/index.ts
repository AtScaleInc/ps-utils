// ============================================================
// Inference module public API
//
// Entry point for the pluggable inference system.
// Import from here rather than from individual files.
//
// Quick start:
//   import { createDefaultEngine } from "./inference.js";
//   const engine = createDefaultEngine();
//   const hierarchies = engine.inferHierarchies(columns, indexes);
// ============================================================

export { InferencePlugin, VerticalMatch, InferenceEngineOptions } from "./plugin.js";
export { AbstractVerticalPlugin, HierarchySequence } from "./base-plugin.js";
export { InferenceEngine } from "./engine.js";

// Built-in vertical plugins
export { FinancialServicesPlugin } from "./verticals/financial-services.js";
export { RetailEcommercePlugin } from "./verticals/retail-ecommerce.js";
export { HealthcarePlugin } from "./verticals/healthcare.js";
export { TelecomPlugin } from "./verticals/telecom.js";
export { ManufacturingPlugin } from "./verticals/manufacturing.js";
export { RealEstatePlugin } from "./verticals/real-estate.js";
export { EnergyUtilitiesPlugin } from "./verticals/energy-utilities.js";
export { MediaAdvertisingPlugin } from "./verticals/media-advertising.js";
export { HumanResourcesPlugin } from "./verticals/human-resources.js";
export { TravelHospitalityPlugin } from "./verticals/travel-hospitality.js";
export { EducationPlugin } from "./verticals/education.js";
export { InsurancePlugin } from "./verticals/insurance.js";
export { LogisticsPlugin } from "./verticals/logistics.js";
export { GovernmentPlugin } from "./verticals/government.js";
export { PharmaPlugin } from "./verticals/pharma.js";

import { InferenceEngine } from "./engine.js";
import { InferenceEngineOptions } from "./plugin.js";
import { FinancialServicesPlugin } from "./verticals/financial-services.js";
import { RetailEcommercePlugin } from "./verticals/retail-ecommerce.js";
import { HealthcarePlugin } from "./verticals/healthcare.js";
import { TelecomPlugin } from "./verticals/telecom.js";
import { ManufacturingPlugin } from "./verticals/manufacturing.js";
import { RealEstatePlugin } from "./verticals/real-estate.js";
import { EnergyUtilitiesPlugin } from "./verticals/energy-utilities.js";
import { MediaAdvertisingPlugin } from "./verticals/media-advertising.js";
import { HumanResourcesPlugin } from "./verticals/human-resources.js";
import { TravelHospitalityPlugin } from "./verticals/travel-hospitality.js";
import { EducationPlugin } from "./verticals/education.js";
import { InsurancePlugin } from "./verticals/insurance.js";
import { LogisticsPlugin } from "./verticals/logistics.js";
import { GovernmentPlugin } from "./verticals/government.js";
import { PharmaPlugin } from "./verticals/pharma.js";

/**
 * Returns an InferenceEngine pre-loaded with all 15 built-in vertical plugins.
 *
 * @param options - Override default threshold or multi-vertical behaviour.
 *
 * @example
 * // Use defaults
 * const engine = createDefaultEngine();
 *
 * @example
 * // Lower the detection threshold and allow multiple verticals per table
 * const engine = createDefaultEngine({ detectionThreshold: 0.3, allowMultipleVerticals: true });
 *
 * @example
 * // Add a custom vertical on top of the built-ins
 * const engine = createDefaultEngine().addPlugin(myCustomPlugin);
 */
export function createDefaultEngine(options?: InferenceEngineOptions): InferenceEngine {
  return new InferenceEngine(
    [
      new FinancialServicesPlugin(),
      new RetailEcommercePlugin(),
      new HealthcarePlugin(),
      new TelecomPlugin(),
      new ManufacturingPlugin(),
      new RealEstatePlugin(),
      new EnergyUtilitiesPlugin(),
      new MediaAdvertisingPlugin(),
      new HumanResourcesPlugin(),
      new TravelHospitalityPlugin(),
      new EducationPlugin(),
      new InsurancePlugin(),
      new LogisticsPlugin(),
      new GovernmentPlugin(),
      new PharmaPlugin(),
    ],
    options,
  );
}
