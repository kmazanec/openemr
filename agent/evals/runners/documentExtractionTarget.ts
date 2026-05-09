/**
 * §B.10 eval target — builds pipeline `Deps` per case kind, runs the
 * compiled graph, and reduces the run to a structural verdict the
 * suite asserts against the manifest's `expectedStatus` /
 * `expectedErrorCode`.
 *
 * The target is consumed by:
 *   - the per-MR Vitest cases (`agent/evals/cases/document-extraction/`)
 *     where every external boundary is stubbed (`createStubVisionInvoker`);
 *   - the LangSmith experiment (`documentExtractionSuite.runExperiment`)
 *     where the vision invoker is the real `createAnthropicVisionInvocation`,
 *     while the rasterizer / Spaces client / artifact store / Tier-1 RPC
 *     stay stubbed (the eval's job is to score model behavior, not to
 *     prove infra).
 *
 * Stubbing model:
 *   - `Rasterizer`: deterministic — synthesizes one PNG per page based
 *     on the manifest's `pageCount`. The `oversized` case overrides
 *     the rasterizer to report 250 pages so the cost-cap pre-flight
 *     fires; the `corrupted` case lets `pageCount` throw the way
 *     real Poppler would.
 *   - `SpacesClient`: in-memory bag keyed by `(bucket, key)`; canonical
 *     bytes are pre-loaded from the fixture file.
 *   - `ExtractionArtifactStore`: in-memory bag with the same shape the
 *     §B.7 e2e test uses.
 *   - `OpenEmrDocumentReferenceClient`: returns a deterministic UUID.
 *   - `fetchChartDemographics`: returns the manifest archetype's
 *     demographics from `documentExtractionFixtures`.
 *   - `fetchChartSnapshot`: returns the same demographics inside an
 *     otherwise-empty ChartSnapshot, so `emitDeltas` has chart state
 *     to diff against.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatAnthropic } from '@langchain/anthropic';
import { type ContentBlock, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { pino } from 'pino';

import { createPipelineGraph, type PipelineDeps } from '../../src/pipeline/index.js';
import { initialPipelineState } from '../../src/pipeline/state.js';
import {
    DEFAULT_VISION_MODEL,
    TransientVisionError,
    userInstruction,
    VISION_SYSTEM_PROMPT,
    VisionSchemaError,
    type VisionInvocation,
    type VisionInvokeInput,
} from '../../src/pipeline/nodes/vision.js';
import { intakeFormSchema } from '../../src/pipeline/schemas/intakeForm.js';
import { labPdfSchema } from '../../src/pipeline/schemas/labPdf.js';
import { type Rasterizer } from '../../src/pipeline/rasterizer.js';
import { keyForCanonical, type SpacesClient } from '../../src/storage/spaces.js';
import {
    type ArtifactStatus,
    type DocumentLockHandle,
    type ExtractionArtifact,
    type ExtractionArtifactStore,
    type NewExtractionArtifact,
} from '../../src/state/extractionArtifacts.js';
import type { ChartSnapshot, Demographics } from '../../src/snapshot/types.js';

import { type CaseKind, type ManifestEntry } from '../fixtures/regenerate-document-extraction.js';
import {
    chartDemographicsForCase,
    documentDemographicsForCase,
    loadFixtureBytes,
    pidForArchetype,
} from './documentExtractionFixtures.js';

const noopLogger = pino({ level: 'silent' });

/** ---- Stub builders ----------------------------------------------------- */

interface FakeSpacesContext {
    readonly client: SpacesClient;
    readonly stored: Map<string, Buffer>;
    readonly deletedKeys: string[];
}

const buildFakeSpaces = (canonicalKey: string, canonicalBytes: Buffer): FakeSpacesContext => {
    const stored = new Map<string, Buffer>();
    const deletedKeys: string[] = [];
    stored.set(canonicalKey, canonicalBytes);

    const client: SpacesClient = {
        bucket: 'fixture.bucket',
        putObject: (input: { key: string; body: Buffer }) => {
            stored.set(input.key, input.body);
            return Promise.resolve();
        },
        getObject: (input: { key: string }) => {
            const buf = stored.get(input.key);
            if (buf === undefined) {
                return Promise.reject(new Error(`fake spaces: no object at ${input.key}`));
            }
            return Promise.resolve({ body: buf, contentType: 'application/octet-stream' });
        },
        deleteObject: (input: { key: string }) => {
            deletedKeys.push(input.key);
            stored.delete(input.key);
            return Promise.resolve();
        },
        presignGetUrl: (key: string) => Promise.resolve(`https://fake.signed/${key}`),
        presignPutUrl: (key: string) => Promise.resolve(`https://fake.signed/put/${key}`),
        destroy: () => undefined,
    };
    return { client, stored, deletedKeys };
};

interface FakeArtifactStoreContext {
    readonly store: ExtractionArtifactStore;
    readonly inserts: NewExtractionArtifact[];
    readonly updates: { artifactId: string; status: ArtifactStatus; deltasJson: unknown }[];
}

const buildFakeArtifactStore = (): FakeArtifactStoreContext => {
    const inserts: NewExtractionArtifact[] = [];
    const updates: { artifactId: string; status: ArtifactStatus; deltasJson: unknown }[] = [];

    const store: ExtractionArtifactStore = {
        claimDocumentLock: () => {
            const handle: DocumentLockHandle = { release: () => Promise.resolve() };
            return Promise.resolve(handle);
        },
        findArtifactByDocumentHash: (
            hash: string,
            version: string,
            pid: number,
        ): Promise<ExtractionArtifact | null> => {
            const found = inserts.find(
                (a) =>
                    a.documentHash === hash &&
                    a.extractorVersion === version &&
                    a.pid === pid,
            );
            if (found === undefined) return Promise.resolve(null);
            return Promise.resolve({
                ...found,
                createdAt: '2026-05-06T00:00:00Z',
                confirmedAt: null,
                confirmedByUser: null,
            });
        },
        findArtifactById: (): Promise<ExtractionArtifact | null> => Promise.resolve(null),
        insertArtifact: (a: NewExtractionArtifact): Promise<ExtractionArtifact> => {
            inserts.push(a);
            return Promise.resolve({
                ...a,
                createdAt: '2026-05-06T00:00:00Z',
                confirmedAt: null,
                confirmedByUser: null,
            });
        },
        updateArtifactStatus: (
            artifactId: string,
            status: ArtifactStatus,
            metadata?: { readonly deltasJson?: unknown },
        ): Promise<ExtractionArtifact | null> => {
            updates.push({ artifactId, status, deltasJson: metadata?.deltasJson });
            return Promise.resolve(null);
        },
        searchArtifacts: () => Promise.resolve([]),
        recordDisposition: () =>
            Promise.resolve({
                disposition: {
                    artifactId: 'eval-stub',
                    fieldPath: 'eval-stub',
                    status: 'pending',
                    acceptedAt: null,
                    acceptedByUser: null,
                },
                artifactStatusRolledTo: null,
            }),
        getDispositions: () => Promise.resolve([]),
    };
    return { store, inserts, updates };
};

/**
 * A deterministic Rasterizer the eval target uses regardless of the
 * actual fixture bytes — the eval's job is to score the pipeline's
 * decisions, not to prove Poppler. Returns one synthetic PNG per page
 * declared on the manifest entry.
 *
 * The `oversized` case overrides this with a Rasterizer that reports
 * 250 pages so the cost-cap pre-flight fires; the `corrupted` case
 * uses the real Poppler rasterizer so `pageCount` actually throws.
 */
const buildDeterministicRasterizer = (pageCount: number): Rasterizer => ({
    pageCount: () => Promise.resolve(pageCount),
    rasterize: () =>
        Promise.resolve(
            Array.from({ length: pageCount }, (_, i) => ({
                pageNum: i + 1,
                pngBytes: Buffer.from(`fake-png-page-${String(i + 1)}`),
            })),
        ),
});

const buildOversizedRasterizer = (): Rasterizer => ({
    pageCount: () => Promise.resolve(250),
    rasterize: () =>
        Promise.reject(new Error('rasterizer should never be called when cost cap fires')),
});

const buildCorruptedRasterizer = (): Rasterizer => ({
    pageCount: () => Promise.reject(new Error("pdfinfo: Couldn't find trailer dictionary")),
    rasterize: () => Promise.reject(new Error('pdftoppm: failed to parse')),
});

/** ---- Stubbed vision invoker -------------------------------------------- */

/**
 * Produce a deterministic schema-shaped extraction for a manifest
 * entry. The per-MR Vitest gate uses this so the test surface is
 * structural (does the pipeline route the way the case expects?)
 * without paying for a real model call.
 *
 * The shape mirrors what `withStructuredOutput(labPdfSchema)` returns
 * for a clean lab and what `withStructuredOutput(intakeFormSchema)`
 * returns for a clean intake.
 *
 * The wrong-patient adversarial case is special: the manifest's
 * `patient.archetype` is the *envelope* patient (Kowalski) so the
 * chart fetch returns Kowalski; but the *document* contains Chen
 * (the source PDF is Chen's lipid panel). `documentDemographicsForCase`
 * honors that by returning Chen's demographics for the document side
 * even though the envelope is Kowalski's, which is exactly what makes
 * patientMatch refuse.
 */
export const buildStubExtraction = (entry: ManifestEntry): unknown => {
    const demo = documentDemographicsForCase(entry);
    const cited = (value: string, conf = 0.95) => ({
        value,
        page: 1,
        bbox: [0, 0, 1, 1] as const,
        quote: value,
        confidence: conf,
    });

    if (entry.docType === 'referral_letter') {
        return {
            sender_provider: {
                name: cited('Helen Park, MD'),
                npi: cited('1618829315'),
            },
            recipient_provider: {
                name: cited('Jonathan Liu, MD'),
                npi: cited('1748392758'),
            },
            patient_identifiers: {
                name: cited(demo.displayName),
                dob: cited(demo.dateOfBirth ?? '1900-01-01'),
            },
            reason_for_referral: cited(
                'Evaluation of statin-refractory hyperlipidemia',
            ),
            past_medical_history: [
                {
                    condition: 'Hyperlipidemia',
                    icd10: 'E78.5',
                    page: 1,
                    bbox: [0, 0, 1, 1] as const,
                    quote: 'Hyperlipidemia (E78.5)',
                    confidence: 0.92,
                },
            ],
            current_medications: [
                {
                    name: 'atorvastatin',
                    dose: '40 mg',
                    route: 'PO',
                    frequency: 'daily',
                    page: 1,
                    bbox: [0, 0, 1, 1] as const,
                    quote: 'atorvastatin 40 mg PO daily',
                    confidence: 0.92,
                },
            ],
            allergies: [],
            pertinent_labs: [
                {
                    analyte_name: 'LDL-C',
                    value: '142',
                    unit: 'mg/dL',
                    abnormal_flag: 'high',
                    page: 1,
                    bbox: [0, 0, 1, 1] as const,
                    quote: 'LDL-C: 142 mg/dL',
                    confidence: 0.93,
                },
            ],
        };
    }

    if (entry.docType === 'lab_pdf') {
        const isMultiPanel = entry.caseKind === 'lab-pdf-multi-panel';
        const baseResults = [
            {
                analyte_name: 'Hemoglobin A1c',
                value: '7.2',
                unit: '%',
                collection_date: '2026-04-30',
                page: 1,
                bbox: [0, 0, 1, 1] as const,
                quote: '7.2',
                confidence: 0.95,
            },
            {
                analyte_name: 'Total Cholesterol',
                value: '210',
                unit: 'mg/dL',
                collection_date: '2026-04-30',
                page: 1,
                bbox: [0, 0, 1, 1] as const,
                quote: '210',
                confidence: 0.92,
            },
        ];
        const multiPanelExtras = [
            {
                analyte_name: 'LDL',
                value: '140',
                unit: 'mg/dL',
                collection_date: '2026-04-30',
                page: 1,
                bbox: [0, 0, 1, 1] as const,
                quote: '140',
                confidence: 0.9,
            },
            {
                analyte_name: 'HDL',
                value: '45',
                unit: 'mg/dL',
                collection_date: '2026-04-30',
                page: 1,
                bbox: [0, 0, 1, 1] as const,
                quote: '45',
                confidence: 0.9,
            },
        ];
        const sexValue = demo.sex === 'male' || demo.sex === 'female' ? demo.sex : 'unknown';
        return {
            patient_demographics: {
                name: cited(demo.displayName),
                dob: cited(demo.dateOfBirth ?? '1900-01-01'),
                sex: cited(sexValue),
            },
            results: isMultiPanel ? [...baseResults, ...multiPanelExtras] : baseResults,
            // ordering_provider is *not* a cited field envelope —
            // the schema puts `name` (and optional npi) at the top
            // level alongside page/bbox/quote/confidence.
            ordering_provider: {
                name: 'Dr. Patel',
                page: 1,
                bbox: [0, 0, 1, 1] as const,
                quote: 'Dr. Patel',
                confidence: 0.88,
            },
        };
    }

    return {
        patient_demographics: {
            name: cited(demo.displayName),
            dob: cited(demo.dateOfBirth ?? ''),
            sex: cited(demo.sex ?? 'unknown'),
        },
        allergies: [],
        current_medications: [],
        past_medical_history: [],
        family_history: [],
    };
};

interface StubVisionOptions {
    readonly entry: ManifestEntry;
    /** Confidence multiplier applied uniformly to every cited field. */
    readonly confidenceMultiplier?: number;
    /** When true, the invoker throws `VisionSchemaError`. */
    readonly forceSchemaInvalid?: boolean;
}

/**
 * Stub `VisionInvocation` for the per-MR Vitest gate. Drops the
 * confidence on every cited field by `confidenceMultiplier` (default
 * 1.0) so the OCR-bad / smudged cases produce a low
 * `confidence_distribution` without otherwise changing the shape.
 */
export const createStubVisionInvoker = (options: StubVisionOptions): VisionInvocation => {
    const multiplier = options.confidenceMultiplier ?? 1.0;
    const adjustConfidence = (node: unknown): unknown => {
        if (node === null || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map((item) => adjustConfidence(item));
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            if (key === 'confidence' && typeof value === 'number') {
                out[key] = Math.max(0, Math.min(1, value * multiplier));
            } else {
                out[key] = adjustConfidence(value);
            }
        }
        return out;
    };

    return {
        invoke: (_input: VisionInvokeInput) => {
            if (options.forceSchemaInvalid === true) {
                return Promise.reject(
                    new VisionSchemaError('forced schema-invalid for eval', [
                        'patient_demographics: missing required fields',
                    ]),
                );
            }
            const stubbed = adjustConfidence(buildStubExtraction(options.entry));
            return Promise.resolve({ extraction: stubbed });
        },
    };
};

/** ---- Pipeline deps assembly -------------------------------------------- */

const buildChartSnapshot = (demographics: Demographics): ChartSnapshot => ({
    patient: demographics,
    appointment: null,
    diagnoses: [],
    prescriptions: [],
    allergies: [],
    labs: [],
    encounters: [],
    reminders: [],
    medications: [],
});

export interface RunOptions {
    /**
     * When set, replaces the stub vision invoker. The experiment
     * runner passes `createAnthropicVisionInvocation()` here so the
     * real model is exercised.
     */
    readonly visionInvoker?: VisionInvocation;
}

export interface CaseRunResult {
    readonly status: 'persisted' | 'failed';
    readonly errorCode: string | null;
    readonly artifactId: string | null;
    readonly insertedArtifact: NewExtractionArtifact | null;
    readonly deltasUpdate: { artifactId: string; deltasJson: unknown } | null;
    readonly deletedTransientKeys: readonly string[];
    readonly hasCitations: boolean;
    readonly resultRowCount: number;
    readonly minConfidence: number;
    readonly demographicsChanges: readonly string[];
}

const canonicalExtFor = (entry: ManifestEntry): string => {
    if (entry.mime === 'application/pdf') return 'pdf';
    if (entry.mime === 'image/png') return 'png';
    if (entry.mime === 'image/jpeg') return 'jpg';
    if (entry.mime === 'image/tiff') return 'tiff';
    if (
        entry.mime ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
        return 'docx';
    }
    return 'pdf';
};

const isSchemaShape = (schema: unknown): schema is { results?: readonly unknown[] } =>
    schema !== null && typeof schema === 'object';

const collectConfidences = (node: unknown, out: number[]): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) collectConfidences(item, out);
        return;
    }
    for (const [key, value] of Object.entries(node)) {
        if (key === 'confidence' && typeof value === 'number') {
            out.push(value);
        } else {
            collectConfidences(value, out);
        }
    }
};

/**
 * Run the §B.10 pipeline against one manifest entry. Returns a
 * structural verdict the suite scores against the manifest's
 * expectations.
 */
export const runDocumentExtractionCase = async (
    entry: ManifestEntry,
    options: RunOptions = {},
): Promise<CaseRunResult> => {
    const canonicalBytes = await loadFixtureBytes(entry);
    const placeholderUuid = `placeholder-${entry.id}`;
    const canonicalKey = keyForCanonical(
        pidForArchetype(entry.patient.archetype),
        placeholderUuid,
        canonicalExtFor(entry),
    );
    const spacesContext = buildFakeSpaces(canonicalKey, canonicalBytes);
    const storeContext = buildFakeArtifactStore();

    const rasterizer: Rasterizer =
        entry.caseKind === 'adversarial-oversized'
            ? buildOversizedRasterizer()
            : entry.caseKind === 'adversarial-corrupted'
              ? buildCorruptedRasterizer()
              : buildDeterministicRasterizer(entry.pageCount);

    const visionInvoker: VisionInvocation =
        options.visionInvoker ??
        createStubVisionInvoker({
            entry,
            confidenceMultiplier: confidenceMultiplierForCase(entry.caseKind),
            forceSchemaInvalid: shouldForceSchemaInvalid(entry.caseKind),
        });

    const chartDemographics = chartDemographicsForCase(entry);
    const chartSnapshot = buildChartSnapshot(chartDemographics);

    const rpcUuid = `canonical-${entry.id}`;
    const documentReferenceClient = {
        writeDocumentReference: () => Promise.resolve({ documentUuid: rpcUuid }),
    };

    const deps: PipelineDeps = {
        rasterize: {
            openemrSpaces: spacesContext.client,
            agentSpaces: spacesContext.client,
            rasterizer,
            transientPrefix: 'transient',
            logger: noopLogger,
            canonicalExt: canonicalExtFor(entry),
        },
        vision: { logger: noopLogger, invoker: visionInvoker },
        schemaValidate: { logger: noopLogger },
        patientMatch: {
            logger: noopLogger,
            fetchChartDemographics: () => Promise.resolve(chartDemographics),
        },
        persist: {
            artifactStore: storeContext.store,
            openemrSpaces: spacesContext.client,
            documentReferenceClient,
            logger: noopLogger,
            artifactIdGenerator: () => `artifact-${entry.id}`,
            canonicalExt: canonicalExtFor(entry),
            openemrToken: 'eval-token',
            openemrSiteId: 'default',
        },
        emitDeltas: {
            artifactStore: storeContext.store,
            logger: noopLogger,
            fetchChartSnapshot: () => Promise.resolve(chartSnapshot),
        },
        cleanup: {
            openemrSpaces: spacesContext.client,
            transientPrefix: 'transient',
            logger: noopLogger,
        },
    };

    const graph = createPipelineGraph(deps);
    const result = await graph.invoke(
        initialPipelineState({
            documentUuid: placeholderUuid,
            docType: entry.docType,
            pid: pidForArchetype(entry.patient.archetype),
            triggerSource: 'panel',
        }),
    );

    const status: 'persisted' | 'failed' = result.status === 'failed' ? 'failed' : 'persisted';
    const errorCode = (result.errors?.[0]?.code ?? null) as string | null;

    let hasCitations = true;
    let resultRowCount = 0;
    const confidences: number[] = [];
    if (status === 'persisted' && isSchemaShape(result.schema)) {
        // Iterate every "cited field" (object with `quote` + `bbox` +
        // `page`) and confirm bbox/page/quote are all present. The
        // schemaValidate node already enforces this, so we treat any
        // structural breakage as the test's failure to drive the
        // pipeline correctly.
        const visit = (node: unknown): void => {
            if (node === null || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                for (const item of node) visit(item);
                return;
            }
            const obj = node as Record<string, unknown>;
            if (
                typeof obj['quote'] === 'string' &&
                typeof obj['confidence'] === 'number' &&
                typeof obj['page'] === 'number'
            ) {
                if (!Array.isArray(obj['bbox']) || obj['bbox'].length !== 4) {
                    hasCitations = false;
                }
            }
            for (const value of Object.values(obj)) visit(value);
        };
        visit(result.schema);

        const results = result.schema.results;
        if (Array.isArray(results)) resultRowCount = results.length;
        collectConfidences(result.schema, confidences);
    }

    const minConfidence = confidences.length > 0 ? Math.min(...confidences) : 1.0;

    let demographicsChanges: readonly string[] = [];
    const lastUpdate = storeContext.updates[storeContext.updates.length - 1];
    if (
        lastUpdate !== undefined &&
        typeof lastUpdate.deltasJson === 'object' &&
        lastUpdate.deltasJson !== null
    ) {
        const deltas = lastUpdate.deltasJson as { demographicsChanges?: readonly string[] };
        if (Array.isArray(deltas.demographicsChanges)) {
            demographicsChanges = deltas.demographicsChanges;
        }
    }

    return {
        status,
        errorCode,
        artifactId: result.artifactId ?? null,
        insertedArtifact: storeContext.inserts[0] ?? null,
        deltasUpdate:
            lastUpdate !== undefined
                ? { artifactId: lastUpdate.artifactId, deltasJson: lastUpdate.deltasJson }
                : null,
        deletedTransientKeys: spacesContext.deletedKeys,
        hasCitations,
        resultRowCount,
        minConfidence,
        demographicsChanges,
    };
};

const confidenceMultiplierForCase = (kind: CaseKind): number => {
    if (kind === 'degraded-smudged') return 0.5;
    if (kind === 'degraded-ocr-bad') return 0.45;
    return 1.0;
};

const shouldForceSchemaInvalid = (kind: CaseKind): boolean => {
    return (
        kind === 'degraded-rotated' ||
        kind === 'degraded-blank' ||
        kind === 'degraded-unrelated' ||
        kind === 'adversarial-prompt-injection'
    );
};

/** ---- Inline-base64 vision invoker (LangSmith experiment) -------------- */

/**
 * The eval harness wires the pipeline against `buildFakeSpaces`, which
 * mints `https://fake.signed/...` URLs for every page. Real Anthropic
 * cannot fetch those, so the production `createAnthropicVisionInvocation`
 * (which sends `{type: 'image', url: page.signedUrl, ...}`) returns
 * 400 "Unable to download the file" on every case.
 *
 * This invoker bypasses the URL flow entirely: it ignores the
 * `pages[].signedUrl` field, reads the source bytes from the closed-
 * over `entry`, renders/converts them to PNG locally, and sends the
 * page images inline as base64. The system prompt + user instruction
 * + delimiters all match the production invoker exactly so the
 * model's input shape is the same.
 *
 * Trade-offs:
 *   - Skips the signed-URL leg entirely; that leg is covered by
 *     `tests/storage/spaces.test.ts` and the production code path.
 *   - Re-rasterizes inside the invoker so the eval doesn't depend on
 *     whatever placeholder bytes the harness's stub rasterizer
 *     produced. The dollar-cap pre-flight in the rasterize node still
 *     fires off the manifest's stub `pageCount` — the real-vendor
 *     cost-cap test uses adversarial-oversized which never reaches
 *     vision.
 */

const runChild = async (cmd: string, args: readonly string[]): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', (err: Error) => reject(err));
        child.on('close', (code: number | null) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with ${String(code)}; stderr=${stderr}`));
        });
    });
};

/**
 * Render the entry's source bytes into one PNG per page. PDFs go
 * through Poppler's `pdftoppm`; PNGs pass through unchanged; TIFFs
 * are converted via ImageMagick `convert`. Each call uses a fresh
 * temp directory so concurrent cases don't collide.
 */
const renderPagesToPng = async (entry: ManifestEntry): Promise<readonly Buffer[]> => {
    const sourceBytes = await loadFixtureBytes(entry);
    const tmp = await mkdtemp(join(tmpdir(), `eval-vision-${entry.id}-`));
    try {
        const ext = entry.path.toLowerCase().split('.').pop() ?? '';
        if (ext === 'png') {
            return [sourceBytes];
        }
        if (ext === 'jpg' || ext === 'jpeg') {
            // Anthropic accepts JPEG natively; no re-encode needed but
            // we still return as a single page.
            return [sourceBytes];
        }
        if (ext === 'tif' || ext === 'tiff') {
            const inPath = join(tmp, 'in.tiff');
            const outBase = join(tmp, 'page');
            await writeFile(inPath, sourceBytes);
            // ImageMagick: `convert in.tiff page-%d.png`. For
            // multi-page TIFFs this produces page-0.png, page-1.png,
            // ...; for single-page TIFFs (the common case in our
            // fixtures) it produces page.png with no suffix.
            await runChild('convert', [inPath, `${outBase}.png`]);
            const files = (await readdir(tmp))
                .filter((f) => f.startsWith('page') && f.endsWith('.png'))
                .sort();
            const buffers: Buffer[] = [];
            for (const f of files) buffers.push(await readFile(join(tmp, f)));
            if (buffers.length === 0) {
                throw new Error(`TIFF conversion produced no PNGs for ${entry.id}`);
            }
            return buffers;
        }
        if (ext === 'pdf') {
            const inPath = join(tmp, 'in.pdf');
            const outBase = join(tmp, 'page');
            await writeFile(inPath, sourceBytes);
            // Poppler: `pdftoppm -png -r 150 in.pdf page` produces
            // page-1.png, page-2.png, ... 150 DPI matches the
            // production rasterizer's output resolution.
            await runChild('pdftoppm', ['-png', '-r', '150', inPath, outBase]);
            const files = (await readdir(tmp))
                .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
                .sort((a, b) => {
                    // Sort numerically by page index, not lexically:
                    // page-10.png must follow page-9.png.
                    const pageRe = /page-(\d+)\.png$/;
                    const idx = (s: string): number => {
                        const m = pageRe.exec(s);
                        return m === null ? 0 : Number.parseInt(m[1] ?? '0', 10);
                    };
                    return idx(a) - idx(b);
                });
            const buffers: Buffer[] = [];
            for (const f of files) buffers.push(await readFile(join(tmp, f)));
            if (buffers.length === 0) {
                throw new Error(`pdftoppm produced no PNGs for ${entry.id}`);
            }
            return buffers;
        }
        throw new Error(`renderPagesToPng: unsupported extension '${ext}' for ${entry.id}`);
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
};

const buildInlinePageBlocks = (
    pageCount: number,
    pngBuffers: readonly Buffer[],
): ContentBlock.Standard[] => {
    const blocks: ContentBlock.Standard[] = [];
    for (let i = 0; i < pageCount; i += 1) {
        const buf = pngBuffers[i];
        if (buf === undefined) {
            throw new Error(`buildInlinePageBlocks: missing buffer for page ${String(i + 1)}`);
        }
        blocks.push({ type: 'text', text: `<DOCUMENT_PAGE_${String(i + 1)}>` });
        blocks.push({
            type: 'image',
            mimeType: 'image/png',
            data: buf.toString('base64'),
        });
        blocks.push({ type: 'text', text: `</DOCUMENT_PAGE_${String(i + 1)}>` });
    }
    return blocks;
};

/**
 * Vision invoker that sends real page bytes inline (base64) instead
 * of relying on a signed-URL fetch. Use for the LangSmith experiment
 * only — the per-MR Vitest gate uses `createStubVisionInvoker` and
 * production uses `createAnthropicVisionInvocation`.
 */
export const createInlineImageVisionInvocation = (options: {
    readonly apiKey: string;
    readonly entry: ManifestEntry;
    readonly model?: string;
}): VisionInvocation => {
    const model = options.model ?? process.env['ANTHROPIC_MODEL_VISION'] ?? DEFAULT_VISION_MODEL;
    const labPdfClient = new ChatAnthropic({
        model,
        apiKey: options.apiKey,
        temperature: 0,
    }).withStructuredOutput(labPdfSchema, { name: 'lab_pdf_extraction', includeRaw: true });
    const intakeFormClient = new ChatAnthropic({
        model,
        apiKey: options.apiKey,
        temperature: 0,
    }).withStructuredOutput(intakeFormSchema, { name: 'intake_form_extraction', includeRaw: true });

    return {
        invoke: async ({ docType, pages }: VisionInvokeInput) => {
            const pngBuffers = await renderPagesToPng(options.entry);
            const client = docType === 'lab_pdf' ? labPdfClient : intakeFormClient;
            const userMessage = new HumanMessage({
                content: [
                    { type: 'text', text: userInstruction(docType) },
                    ...buildInlinePageBlocks(pages.length, pngBuffers),
                ],
            });
            let result;
            try {
                result = await client.invoke([
                    new SystemMessage(VISION_SYSTEM_PROMPT),
                    userMessage,
                ]);
            } catch (err) {
                throw classifyExperimentVisionError(err);
            }
            const usageMeta = (
                result.raw as {
                    usage_metadata?: { input_tokens?: number; output_tokens?: number };
                }
            ).usage_metadata;
            const usage =
                usageMeta !== undefined
                    ? {
                          model,
                          inputTokens: usageMeta.input_tokens ?? 0,
                          outputTokens: usageMeta.output_tokens ?? 0,
                      }
                    : undefined;
            return {
                extraction: result.parsed,
                ...(usage !== undefined ? { usage } : {}),
            };
        },
    };
};

const classifyExperimentVisionError = (err: unknown): Error => {
    if (err instanceof Error) {
        const status = (err as { status?: number }).status;
        if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
            return new TransientVisionError(err.message, { cause: err });
        }
        const lower = err.message.toLowerCase();
        if (
            lower.includes('failed to parse') ||
            lower.includes('zod') ||
            lower.includes('schema')
        ) {
            return new VisionSchemaError(err.message, [err.message]);
        }
    }
    return err instanceof Error ? err : new Error(String(err));
};

/**
 * Public factory used by `documentExtractionSuite.runExperiment`.
 * Returns a fresh invoker per case so each run renders the right
 * fixture. The previous signature took only an apiKey and lazy-built
 * a single shared invoker that pointed at fake URLs; that path was
 * structurally broken against the real model and is gone.
 */
export const buildExperimentVisionInvoker = (
    apiKey: string,
    entry: ManifestEntry,
): VisionInvocation => createInlineImageVisionInvocation({ apiKey, entry });
