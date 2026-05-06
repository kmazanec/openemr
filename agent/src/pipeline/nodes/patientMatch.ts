/**
 * §B.6 Pipeline node 4 — `patientMatch`.
 *
 * Compare extracted demographics (name + DOB) against the chart's
 * demographics for the supplied `pid`. Three buckets per
 * `W2_ARCHITECTURE.md` §"Patient match":
 *
 *   - Confident match (both axes 1.0)         → status='matched',
 *     `confidenceSignal` recorded with `patientMatchPartial=false`.
 *   - Partial match (no axis at 0.0, at least
 *     one below 1.0)                          → status='matched',
 *     `confidenceSignal.patientMatchPartial=true` so the verifier's
 *     downstream Q14 hard-stop logic knows to gate confidently.
 *   - Confident mismatch (either axis 0.0)    → status='failed',
 *     `errors=[{code:'patient_mismatch', mismatch_reason}]`. We do
 *     *not* write `confidenceSignal` in this path — the artifact's
 *     `failed` status is the load-bearing signal and a partial score
 *     would be misleading.
 *
 * The node also fail-closes on:
 *   - upstream `failed` status (no-op short-circuit so this node never
 *     runs after schemaValidate refused).
 *   - snapshot fetch error (we cannot match against a missing chart;
 *     refusing is safer than passing zero scores through).
 *   - missing demographics in the extracted schema (vision should
 *     already have rejected this, but we never assume upstream did).
 */

import type { Logger } from 'pino';

import type { Demographics } from '../../snapshot/types.js';
import { matchDob, matchName, type MatchScore } from '../match/demographics.js';
import {
    type ConfidenceSignal,
    type PipelineError,
    type PipelineState,
} from '../state.js';

export interface PatientMatchDeps {
    readonly logger: Logger;
    /**
     * Boundary for `getPatientContext` — production wires the snapshot
     * client; tests stub it. Returning the W1 `Demographics` shape keeps
     * this node decoupled from the HTTP layer (auth tokens, base URL,
     * site id are the caller's problem).
     */
    readonly fetchChartDemographics: (pid: number) => Promise<Demographics>;
}

interface CitedField {
    readonly value: unknown;
}

const looksLikeCitedField = (v: unknown): v is CitedField =>
    v !== null && typeof v === 'object' && 'value' in (v as Record<string, unknown>);

const extractCitedString = (
    schema: unknown,
    field: 'name' | 'dob',
): string | null => {
    if (schema === null || typeof schema !== 'object') return null;
    const root = schema as Record<string, unknown>;
    const demographics = root['patient_demographics'];
    if (demographics === null || typeof demographics !== 'object') return null;
    const cited = (demographics as Record<string, unknown>)[field];
    if (!looksLikeCitedField(cited)) return null;
    return typeof cited.value === 'string' ? cited.value : null;
};

const fail = (state: PipelineState, error: PipelineError): Partial<PipelineState> => ({
    status: 'failed',
    errors: [...state.errors, error],
});

const isPartial = (name: MatchScore, dob: MatchScore): boolean =>
    name < 1.0 || dob < 1.0;

/**
 * Dev-only diagnostic payload for the patient-match log lines. In
 * production these strings are PHI; in development they are the only
 * way to see what the vision model returned, since `extraction` is
 * redacted at the pino layer and the `failed` artifact is never
 * persisted to postgres on a refusal. Gated on `NODE_ENV` so a real
 * deployment cannot accidentally leak names/DOBs into application logs.
 */
const devDiagnostics = (
    extractedName: string,
    extractedDob: string,
    chart: Demographics,
): Record<string, string | null> | undefined => {
    if (process.env['NODE_ENV'] === 'production') return undefined;
    return {
        extractedName,
        extractedDob,
        chartDisplayName: chart.displayName,
        chartDateOfBirth: chart.dateOfBirth,
    };
};

const buildWarnings = (name: MatchScore, dob: MatchScore): readonly string[] => {
    const warnings: string[] = [];
    if (name === 0.6) warnings.push('name_partial_match');
    if (dob === 0.5) warnings.push('dob_off_by_one_day');
    return warnings;
};

export const patientMatch = async (
    state: PipelineState,
    deps: PatientMatchDeps,
): Promise<Partial<PipelineState>> => {
    if (state.status === 'failed') {
        // Upstream node already refused. Don't re-fetch, don't re-error.
        return {};
    }

    const extractedName = extractCitedString(state.schema, 'name');
    const extractedDob = extractCitedString(state.schema, 'dob');
    if (extractedName === null || extractedDob === null) {
        const isDev = process.env['NODE_ENV'] !== 'production';
        deps.logger.warn(
            {
                documentUuid: state.documentUuid,
                pid: state.pid,
                hasExtractedName: extractedName !== null,
                hasExtractedDob: extractedDob !== null,
                ...(isDev ? { extractedName, extractedDob } : {}),
            },
            'patientMatch: extracted demographics missing name or dob',
        );
        return fail(state, {
            code: 'patient_mismatch',
            message: 'extracted demographics missing required fields',
            details: { mismatch_reason: 'extracted_demographics_incomplete' },
        });
    }

    let chart: Demographics;
    try {
        chart = await deps.fetchChartDemographics(state.pid);
    } catch (err) {
        deps.logger.error(
            { documentUuid: state.documentUuid, pid: state.pid, err: (err as Error).message },
            'patientMatch: failed to fetch chart demographics',
        );
        return fail(state, {
            code: 'patient_mismatch',
            message: 'unable to verify chart demographics',
            details: { mismatch_reason: 'snapshot_fetch_failed' },
        });
    }

    const nameScore = matchName(extractedName, chart.displayName);
    const dobScore = matchDob(extractedDob, chart.dateOfBirth);

    if (nameScore === 0.0 || dobScore === 0.0) {
        const reasons: string[] = [];
        if (nameScore === 0.0) reasons.push('name');
        if (dobScore === 0.0) reasons.push('dob');
        const mismatchReason = reasons.join('+');
        deps.logger.warn(
            {
                documentUuid: state.documentUuid,
                pid: state.pid,
                mismatchReason,
                nameScore,
                dobScore,
                ...devDiagnostics(extractedName, extractedDob, chart),
            },
            'patientMatch: confident mismatch — refusing extraction',
        );
        return fail(state, {
            code: 'patient_mismatch',
            message: 'extracted demographics do not match chart',
            details: { mismatch_reason: mismatchReason },
        });
    }

    const combinedScore = Number(((nameScore + dobScore) / 2).toFixed(5));
    const partial = isPartial(nameScore, dobScore);
    const confidenceSignal: ConfidenceSignal = {
        patientMatchScore: combinedScore,
        patientMatchPartial: partial,
        demographicsWarnings: buildWarnings(nameScore, dobScore),
    };

    deps.logger.info(
        {
            documentUuid: state.documentUuid,
            pid: state.pid,
            nameScore,
            dobScore,
            partial,
            ...devDiagnostics(extractedName, extractedDob, chart),
        },
        'patientMatch: chart demographics matched',
    );

    return { status: 'matched', confidenceSignal };
};
