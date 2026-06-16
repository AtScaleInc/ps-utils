/**
 * Opaque ID generation for the fingerprint.
 *
 * Assigns sequential, human-readable IDs (D1, D2, F1, D1.H1, D1.H1.L3, …)
 * to model entities without embedding the original names.  IDs are stable
 * within a single extraction run (entities are numbered in encounter order).
 *
 * The mapping from original names to IDs is intentionally NOT written to the
 * fingerprint file — once the IdMapper is discarded the mapping is gone.
 */

export class IdMapper {
  private dimCounter  = 0;
  private factCounter = 0;
  private dimMap  = new Map<string, string>();
  private factMap = new Map<string, string>();

  // Per-dimension sub-counters
  private hierCounters  = new Map<string, number>();
  private levelCounters = new Map<string, number>();
  private hierMap  = new Map<string, string>();
  private levelMap = new Map<string, string>();

  dimensionId(dimUniqueName: string): string {
    if (!this.dimMap.has(dimUniqueName)) {
      this.dimMap.set(dimUniqueName, `D${++this.dimCounter}`);
    }
    return this.dimMap.get(dimUniqueName)!;
  }

  factId(factUniqueName: string): string {
    if (!this.factMap.has(factUniqueName)) {
      this.factMap.set(factUniqueName, `F${++this.factCounter}`);
    }
    return this.factMap.get(factUniqueName)!;
  }

  hierarchyId(dimUniqueName: string, hierUniqueName: string): string {
    const dimId = this.dimensionId(dimUniqueName);
    const key   = `${dimUniqueName}::${hierUniqueName}`;
    if (!this.hierMap.has(key)) {
      const count = (this.hierCounters.get(dimId) ?? 0) + 1;
      this.hierCounters.set(dimId, count);
      this.hierMap.set(key, `${dimId}.H${count}`);
    }
    return this.hierMap.get(key)!;
  }

  levelId(dimUniqueName: string, hierUniqueName: string, levelUniqueName: string): string {
    const hierId = this.hierarchyId(dimUniqueName, hierUniqueName);
    const key    = `${dimUniqueName}::${hierUniqueName}::${levelUniqueName}`;
    if (!this.levelMap.has(key)) {
      const count = (this.levelCounters.get(hierId) ?? 0) + 1;
      this.levelCounters.set(hierId, count);
      this.levelMap.set(key, `${hierId}.L${count}`);
    }
    return this.levelMap.get(key)!;
  }

  private measureCounters = new Map<string, number>();
  private measureMap      = new Map<string, string>();

  measureIdFor(factUniqueName: string, measureUniqueName: string): string {
    const factId = this.factId(factUniqueName);
    const key    = `${factUniqueName}::${measureUniqueName}`;
    if (!this.measureMap.has(key)) {
      const count = (this.measureCounters.get(factId) ?? 0) + 1;
      this.measureCounters.set(factId, count);
      this.measureMap.set(key, `${factId}.M${count}`);
    }
    return this.measureMap.get(key)!;
  }

}
