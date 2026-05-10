import { traceable } from 'langsmith/traceable';

import { createLogger } from '../../observability/logger.js';
import {
    hashIdForTrace,
    setRunMetadata,
    tagSalt,
} from '../../observability/traceMetadata.js';
import type {
    ExtractionArtifact,
    ExtractionArtifactStore,
} from '../../state/extractionArtifacts.js';
import { MS_PER_DAY } from '../followUps.js';
import type { BriefingState, BriefingStateUpdate } from '../state.js';
import type { DocumentEvidenceArgs, ExtractedFactSnippet } from '../types.js';

/**
 * §C.1 `documentEvidenceRetriever` node — replaces the A.7 stub.
 *
 * The supervisor narrows its structured-output args into
 * `state.documentEvidenceArgs` (a typed {@link DocumentEvidenceArgs});
 * this node reads that slot, queries `extraction_artifacts` for the
 * envelope's patient (the `pid` scope is non-negotiable — the model
 * cannot widen it), projects each artifact's `schemaJson` into one or
 * more {@link ExtractedFactSnippet} candidates, ranks them by query
 * relevance × recency, and writes the top-`top_k` to
 * `state.documentEvidenceSnippets` for the supervisor's next iteration
 * to reason over.
 *
 * Schema-projection drops fact-shaped objects missing one of `bbox`,
 * `page`, or `quote` — and reports the dropped count in trace metadata
 * so an upstream extractor-schema change shows up as an observability
 * signal rather than a silent regression.
 *
 * Ranking is `keywordScore + recencyBonus`, each bounded in `[0, 1]`,
 * per `W2_ARCHITECTURE.md` §"documentEvidenceRetriever". Eval cases pin
 * behavior, not the ranking algorithm; swapping in a real reranker is a
 * future-phase change with no shape impact.
 */

const logger = createLogger('graph:documentEvidenceRetriever');

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_TOP_K = 5;

/**
 * §C.1 deps. The store seam (`searchArtifacts`) lets tests pass a fake
 * with scripted artifact rows without standing up Postgres. `now` is
 * injectable so recency-bucket assertions are deterministic; production
 * binds `() => new Date()`.
 */
export interface DocumentEvidenceRetrieverDeps {
    readonly store: Pick<ExtractionArtifactStore, 'searchArtifacts'>;
    readonly now?: () => Date;
}

interface SnippetCandidate {
    readonly snippet: ExtractedFactSnippet;
    readonly createdAtMs: number;
    readonly corpus: ReadonlySet<string>;
}

/** Locator-bearing keys consumed at the matched-leaf level — never recursed into. */
const LOCATOR_KEYS = new Set(['bbox', 'quote', 'page', 'value', 'confidence']);

const tokenize = (s: string): readonly string[] =>
    s.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t.length > 0);

const buildCorpus = (snippet: ExtractedFactSnippet): ReadonlySet<string> => {
    return new Set<string>([
        ...tokenize(snippet.quote),
        ...tokenize(snippet.fieldPath),
    ]);
};

const isFactLocator = (obj: Record<string, unknown>): boolean => {
    if (typeof obj['quote'] !== 'string' || obj['quote'].length === 0) return false;
    if (!Number.isInteger(obj['page'])) return false;
    const bbox = obj['bbox'];
    if (!Array.isArray(bbox) || bbox.length !== 4) return false;
    return bbox.every((n) => typeof n === 'number');
};

const collectFactCandidates = (
    value: unknown,
    path: string,
    out: { readonly fieldPath: string; readonly leaf: Record<string, unknown> }[],
    dropped: { count: number },
): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((entry, idx) => {
            collectFactCandidates(entry, path === '' ? String(idx) : `${path}.${idx}`, out, dropped);
        });
        return;
    }
    const obj = value as Record<string, unknown>;
    if (isFactLocator(obj)) {
        // Matched leaf: collect and stop. Recursing into its locator
        // keys would re-visit primitive values; recursing into sibling
        // metadata risks double-counting nested fact-shaped objects.
        out.push({ fieldPath: path, leaf: obj });
        return;
    }
    // An object with *some* but not all of {bbox, page, quote} is
    // schema-drift — count once and continue recursing for any
    // children it might still have.
    if (obj['bbox'] !== undefined || obj['page'] !== undefined || obj['quote'] !== undefined) {
        dropped.count += 1;
    }
    for (const [key, child] of Object.entries(obj)) {
        if (LOCATOR_KEYS.has(key)) continue;
        collectFactCandidates(child, path === '' ? key : `${path}.${key}`, out, dropped);
    }
};

const projectArtifact = (
    artifact: ExtractionArtifact,
    dropped: { count: number },
): readonly SnippetCandidate[] => {
    const candidates: { readonly fieldPath: string; readonly leaf: Record<string, unknown> }[] = [];
    collectFactCandidates(artifact.schemaJson, '', candidates, dropped);
    const createdAtMs = Date.parse(artifact.createdAt);
    return candidates.map(({ fieldPath, leaf }) => {
        const bbox = leaf['bbox'] as readonly number[];
        const snippet: ExtractedFactSnippet = {
            artifactId: artifact.artifactId,
            documentUuid: artifact.documentUuid,
            docType: artifact.docType,
            fieldPath,
            value: leaf['value'] ?? null,
            page: leaf['page'] as number,
            bbox: [bbox[0] ?? 0, bbox[1] ?? 0, bbox[2] ?? 0, bbox[3] ?? 0] as const,
            quote: leaf['quote'] as string,
            ...(typeof leaf['confidence'] === 'number'
                ? { confidence: leaf['confidence'] }
                : {}),
            extractorVersion: artifact.extractorVersion,
            createdAt: artifact.createdAt,
        };
        return { snippet, createdAtMs, corpus: buildCorpus(snippet) };
    });
};

const keywordScore = (
    query: readonly string[],
    corpus: ReadonlySet<string>,
): number => {
    if (query.length === 0) return 0;
    let hits = 0;
    for (const term of query) {
        if (corpus.has(term)) hits += 1;
    }
    return hits / query.length;
};

/**
 * Recency bonus on `[0, 1]`: 1 for "right now", 0 at `lookback_days` ago,
 * linear in between.
 */
const recencyBonus = (
    createdAtMs: number,
    nowMs: number,
    lookbackDays: number,
): number => {
    if (lookbackDays <= 0) return 0;
    const ageDays = Math.max(0, (nowMs - createdAtMs) / MS_PER_DAY);
    return Math.max(0, 1 - ageDays / lookbackDays);
};

const resolveArgs = (state: BriefingState): {
    readonly args: DocumentEvidenceArgs;
    readonly lookbackDays: number;
    readonly topK: number;
} => {
    const args = state.documentEvidenceArgs;
    if (args === null) {
        throw new Error(
            'documentEvidenceRetriever: state.documentEvidenceArgs is null; supervisor must narrow before routing',
        );
    }
    return {
        args,
        lookbackDays: args.lookback_days ?? DEFAULT_LOOKBACK_DAYS,
        topK: args.top_k ?? DEFAULT_TOP_K,
    };
};

export const createDocumentEvidenceRetriever = (
    deps: DocumentEvidenceRetrieverDeps,
): ((state: BriefingState) => Promise<BriefingStateUpdate>) => {
    const now = deps.now ?? ((): Date => new Date());
    const impl = async (state: BriefingState): Promise<BriefingStateUpdate> => {
        const startedAt = Date.now();
        const { args, lookbackDays, topK } = resolveArgs(state);
        const queryTokens = tokenize(args.query);
        const nowDate = now();
        const since = new Date(nowDate.getTime() - lookbackDays * MS_PER_DAY);

        const artifacts = await deps.store.searchArtifacts({
            pid: state.envelope.patient.pid,
            since,
            ...(args.doc_types !== undefined ? { docTypes: args.doc_types } : {}),
        });

        const dropped = { count: 0 };
        const allCandidates: SnippetCandidate[] = [];
        for (const artifact of artifacts) {
            for (const cand of projectArtifact(artifact, dropped)) {
                allCandidates.push(cand);
            }
        }

        const ranked = allCandidates
            .map((cand) => ({
                cand,
                score:
                    keywordScore(queryTokens, cand.corpus)
                    + recencyBonus(cand.createdAtMs, nowDate.getTime(), lookbackDays),
            }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return b.cand.createdAtMs - a.cand.createdAtMs;
            })
            .slice(0, topK)
            .map((entry) => entry.cand.snippet);

        setRunMetadata({
            tool: 'documentEvidenceRetriever',
            doc_query_hash: hashIdForTrace(args.query, tagSalt()),
            doc_types: args.doc_types ?? null,
            doc_lookback_days: lookbackDays,
            doc_top_k: topK,
            doc_artifact_count: artifacts.length,
            doc_candidate_count: allCandidates.length,
            doc_dropped_candidate_count: dropped.count,
            doc_returned_count: ranked.length,
            latency_ms: Date.now() - startedAt,
        });
        if (dropped.count > 0) {
            logger.warn(
                {
                    pid: state.envelope.patient.pid,
                    droppedCandidateCount: dropped.count,
                    artifactCount: artifacts.length,
                },
                'documentEvidenceRetriever: dropped fact-shaped candidates with incomplete locators (possible schema drift)',
            );
        }

        // §C.5: surface each retrieved artifact's `confidence_signal`
        // JSONB row to the verifier so it can resolve the combined
        // hard-stop (self-reported × schema-warning × patient-match)
        // without re-fetching artifacts. Keyed by `artifactId`; only
        // artifacts whose snippets actually made the top-`top_k` need
        // to be in the map (a fact rejected by the keyword/recency
        // ranker can't be cited downstream).
        const returnedArtifactIds = new Set(ranked.map((s) => s.artifactId));
        const confidenceMap = new Map<string, unknown>();
        for (const artifact of artifacts) {
            if (!returnedArtifactIds.has(artifact.artifactId)) continue;
            confidenceMap.set(artifact.artifactId, artifact.confidenceSignal);
        }

        return {
            documentEvidenceSnippets: ranked,
            documentEvidenceArtifactConfidence: confidenceMap,
        };
    };
    return traceable(impl, { name: 'documentEvidenceRetriever', run_type: 'chain' });
};
