import type { ImportKind } from '../client'

/** One per ps-utils converter (api/smlgen/converters.py KINDS). */
export const IMPORT_KINDS: Record<ImportKind, { label: string; file: string; accept: string; operation: string }> = {
  xml: { label: 'Legacy AtScale model', file: 'AtScale project_2_0 XML export', accept: '.xml,text/xml,application/xml', operation: 'generate-sml-from-xml' },
  ssas: { label: 'SSAS Multidimensional cube', file: 'XMLA Create / ObjectDefinition / Database script', accept: '.xmla,.xml,text/xml,application/xml', operation: 'generate-sml-from-ssas-multidimensional' },
  tabular: { label: 'Tabular model', file: 'TMSL JSON: createOrReplace.database.model', accept: '.xmla,.json,.bim,application/json', operation: 'generate-sml-from-tabular' },
}
