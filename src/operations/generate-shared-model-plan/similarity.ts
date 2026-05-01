/**
 * similarity.ts
 *
 * Fuzzy tree/subtree matching engine for SML projects.
 *
 * Scoring uses Jaccard similarity at each structural level (hierarchies, levels,
 * attributes, columns).  Composite scores are weighted sums so that the most
 * structurally significant signals dominate.
 */

import type {
  SmlProject,
  SmlDimension,
  SmlDataset,
  SmlModel,
} from "./sml-loader.js";

// ============================================================
// Primitive: Jaccard similarity
// ============================================================

/** |A ∩ B| / |A ∪ B|.  Returns 0 when both sets are empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const v of a) if (b.has(v)) intersect++;
  const union = a.size + b.size - intersect;
  return intersect / union;
}

// ============================================================
// Dimension pair matching
// ============================================================

export interface DimPair {
  projectA: string;           // project label (for display)
  dirA: string;               // project dir (for file references)
  dim: SmlDimension;          // from project A
  projectB: string;
  dirB: string;
  otherDim: SmlDimension;     // from project B
  score: number;

  // What the merged dimension would look like
  sharedHierarchyNames: string[];
  onlyInA: string[];          // hierarchy unique_names only in A
  onlyInB: string[];          // hierarchy unique_names only in B
  sharedAttributeNames: string[];
  onlyAttrInA: string[];
  onlyAttrInB: string[];
}

function scoreHierarchyDepth(a: SmlDimension, b: SmlDimension): number {
  // Compare level names within hierarchies that share the same unique_name
  const sharedHiers = [...a.hierarchies].filter((h) =>
    b.hierarchies.some((bh) => bh.uniqueName === h.uniqueName),
  );
  if (sharedHiers.length === 0) return 0;

  let totalLevelScore = 0;
  for (const ha of sharedHiers) {
    const hb = b.hierarchies.find((bh) => bh.uniqueName === ha.uniqueName)!;
    const la = new Set(ha.levels.map((l) => l.uniqueName));
    const lb = new Set(hb.levels.map((l) => l.uniqueName));
    totalLevelScore += jaccard(la, lb);
  }
  return totalLevelScore / sharedHiers.length;
}

export function scoreDimensions(
  projectA: string, dirA: string, a: SmlDimension,
  projectB: string, dirB: string, b: SmlDimension,
): DimPair {
  const hierNamesA = new Set(a.hierarchies.map((h) => h.uniqueName));
  const hierNamesB = new Set(b.hierarchies.map((h) => h.uniqueName));

  // Four signals, each 0–1
  const typeScore      = a.type === b.type ? 1.0 : 0.25;
  const hierScore      = jaccard(hierNamesA, hierNamesB);
  const levelScore     = scoreHierarchyDepth(a, b);
  const attrScore      = jaccard(a.attributeNames, b.attributeNames);
  const backingScore   = jaccard(a.backingDatasets, b.backingDatasets);

  // Weighted composite
  const score =
    0.10 * typeScore +
    0.25 * hierScore +
    0.25 * levelScore +
    0.20 * attrScore +
    0.20 * backingScore;

  const sharedHierarchyNames = [...hierNamesA].filter((h) => hierNamesB.has(h));
  const onlyInA = [...hierNamesA].filter((h) => !hierNamesB.has(h));
  const onlyInB = [...hierNamesB].filter((h) => !hierNamesA.has(h));

  const sharedAttributeNames = [...a.attributeNames].filter((n) => b.attributeNames.has(n));
  const onlyAttrInA = [...a.attributeNames].filter((n) => !b.attributeNames.has(n));
  const onlyAttrInB = [...b.attributeNames].filter((n) => !a.attributeNames.has(n));

  return {
    projectA, dirA, dim: a,
    projectB, dirB, otherDim: b,
    score,
    sharedHierarchyNames, onlyInA, onlyInB,
    sharedAttributeNames, onlyAttrInA, onlyAttrInB,
  };
}

/** Find all dimension pairs above `threshold` across all projects. */
export function findDimPairs(projects: SmlProject[], threshold: number): DimPair[] {
  const pairs: DimPair[] = [];

  for (let i = 0; i < projects.length; i++) {
    for (let j = i; j < projects.length; j++) {
      const pi = projects[i];
      const pj = projects[j];
      const startJ = i === j ? 1 : 0; // within same project: avoid self-compare
      const dimsJ = [...pj.dimensions.values()];

      for (const [, dimI] of pi.dimensions) {
        for (let k = (i === j ? [...pi.dimensions.keys()].indexOf(dimI.uniqueName) + 1 : startJ);
             k < dimsJ.length; k++) {
          const dimJ = dimsJ[k];
          const pair = scoreDimensions(
            pi.label, pi.dir, dimI,
            pj.label, pj.dir, dimJ,
          );
          if (pair.score >= threshold) pairs.push(pair);
        }
      }
    }
  }

  // Sort descending by score
  pairs.sort((a, b) => b.score - a.score);
  return pairs;
}

// ============================================================
// Dataset pair matching
// ============================================================

export interface DatasetPair {
  projectA: string;
  dirA: string;
  dataset: SmlDataset;
  projectB: string;
  dirB: string;
  otherDataset: SmlDataset;
  score: number;
  isIdentical: boolean;     // same connectionId + table (or identical SQL)
  unionColumnCount: number; // size of the merged column set
}

export function scoreDatasets(
  projectA: string, dirA: string, a: SmlDataset,
  projectB: string, dirB: string, b: SmlDataset,
): DatasetPair {
  const isIdentical = a.tableRef.length > 0 && a.tableRef === b.tableRef;

  const colScore  = jaccard(a.columnNames, b.columnNames);
  const nameA = a.label.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameB = b.label.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nameScore = nameA === nameB ? 1.0 : (nameA.includes(nameB) || nameB.includes(nameA) ? 0.5 : 0.0);

  const score = isIdentical ? 1.0 : 0.35 * nameScore + 0.65 * colScore;

  const unionColumns = new Set([...a.columnNames, ...b.columnNames]);

  return {
    projectA, dirA, dataset: a,
    projectB, dirB, otherDataset: b,
    score,
    isIdentical,
    unionColumnCount: unionColumns.size,
  };
}

export function findDatasetPairs(projects: SmlProject[], threshold: number): DatasetPair[] {
  const pairs: DatasetPair[] = [];

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const pi = projects[i];
      const pj = projects[j];
      for (const [, dsI] of pi.datasets) {
        for (const [, dsJ] of pj.datasets) {
          const pair = scoreDatasets(pi.label, pi.dir, dsI, pj.label, pj.dir, dsJ);
          if (pair.score >= threshold || pair.isIdentical) {
            pairs.push(pair);
          }
        }
      }
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  return pairs;
}

// ============================================================
// Model pair matching
// ============================================================

export interface ModelPair {
  projectA: string;
  dirA: string;
  model: SmlModel;
  projectB: string;
  dirB: string;
  otherModel: SmlModel;
  overallScore: number;
  dimensionScore: number;
  metricScore: number;
  datasetScore: number;
  commonDimensions: string[];
  onlyInA: string[];
  onlyInB: string[];
  commonMetrics: string[];
}

export function scoreModels(
  projectA: string, dirA: string, a: SmlModel,
  projectB: string, dirB: string, b: SmlModel,
): ModelPair {
  const dimensionScore = jaccard(a.dimensionNames, b.dimensionNames);
  const datasetScore   = jaccard(a.factDatasets, b.factDatasets);

  const metricsA = new Set(a.metricRefs);
  const metricsB = new Set(b.metricRefs);
  const metricScore = jaccard(metricsA, metricsB);

  const overallScore = 0.45 * dimensionScore + 0.35 * datasetScore + 0.20 * metricScore;

  const commonDimensions = [...a.dimensionNames].filter((d) => b.dimensionNames.has(d));
  const onlyInA = [...a.dimensionNames].filter((d) => !b.dimensionNames.has(d));
  const onlyInB = [...b.dimensionNames].filter((d) => !a.dimensionNames.has(d));
  const commonMetrics = [...metricsA].filter((m) => metricsB.has(m));

  return {
    projectA, dirA, model: a,
    projectB, dirB, otherModel: b,
    overallScore, dimensionScore, metricScore, datasetScore,
    commonDimensions, onlyInA, onlyInB, commonMetrics,
  };
}

export function findModelPairs(projects: SmlProject[], threshold: number): ModelPair[] {
  const pairs: ModelPair[] = [];

  // Cross-project and within-project (multiple models in same project)
  for (let i = 0; i < projects.length; i++) {
    for (let j = i; j < projects.length; j++) {
      const pi = projects[i];
      const pj = projects[j];
      const modelsJ = [...pj.models.values()];

      for (const [, mI] of pi.models) {
        for (let k = (i === j ? [...pi.models.keys()].indexOf(mI.uniqueName) + 1 : 0);
             k < modelsJ.length; k++) {
          const mJ = modelsJ[k];
          const pair = scoreModels(pi.label, pi.dir, mI, pj.label, pj.dir, mJ);
          if (pair.overallScore >= threshold) pairs.push(pair);
        }
      }
    }
  }

  pairs.sort((a, b) => b.overallScore - a.overallScore);
  return pairs;
}

// ============================================================
// Combined analysis result
// ============================================================

export interface SimilarityAnalysis {
  dimPairs:     DimPair[];
  datasetPairs: DatasetPair[];
  modelPairs:   ModelPair[];
}

export function analyzeProjects(projects: SmlProject[], threshold: number): SimilarityAnalysis {
  return {
    dimPairs:     findDimPairs(projects, threshold),
    datasetPairs: findDatasetPairs(projects, threshold),
    modelPairs:   findModelPairs(projects, threshold),
  };
}
