/**
 * Shared helpers for the §B.10 per-MR Vitest cases.
 *
 * The per-MR gate runs every manifest entry through the eval target
 * (`runDocumentExtractionCase`) with the stub vision invoker so the
 * test surface is structural — does the pipeline route the way the
 * case expects, does the failure-isolation hold, do citations land —
 * without paying for a real Anthropic call. The nightly LangSmith
 * experiment runs the same case set against the real model.
 */

import {
    type CaseKind,
    type ManifestEntry,
} from '../../fixtures/regenerate-document-extraction.js';
import { loadEntries } from '../../runners/documentExtractionFixtures.js';

/**
 * Load all manifest entries once per process. Vitest re-imports test
 * files but Node module caching means the manifest is parsed once.
 */
let cachedEntries: readonly ManifestEntry[] | null = null;

export const allEntries = async (): Promise<readonly ManifestEntry[]> => {
    if (cachedEntries !== null) return cachedEntries;
    cachedEntries = await loadEntries();
    return cachedEntries;
};

export const entriesByCaseKind = async (kind: CaseKind): Promise<readonly ManifestEntry[]> => {
    const entries = await allEntries();
    return entries.filter((e) => e.caseKind === kind);
};

export const entriesByCaseKinds = async (
    kinds: readonly CaseKind[],
): Promise<readonly ManifestEntry[]> => {
    const entries = await allEntries();
    const set = new Set(kinds);
    return entries.filter((e) => set.has(e.caseKind));
};

export const entryByCaseId = async (caseId: string): Promise<ManifestEntry> => {
    const entries = await allEntries();
    const found = entries.find((e) => e.id === caseId);
    if (found === undefined) {
        throw new Error(`entryByCaseId: no manifest entry with id ${caseId}`);
    }
    return found;
};
