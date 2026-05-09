/**
 * §B.10 fixture loader — bridges `agent/evals/fixtures/document-extraction/
 * source/manifest.json` and the eval target.
 *
 * Both the per-MR Vitest cases and the LangSmith experiment runner read
 * fixtures through this module so a single source decides:
 *
 *   - which 26 cases run,
 *   - which fixture file each case binds to,
 *   - what the expected pipeline outcome is per case.
 *
 * Stub demographics for the seven fixture archetypes live here too, so
 * the eval target's `fetchChartDemographics` boundary returns the same
 * value every test sees. The four `FixturePatient` archetypes (p01-chen,
 * p02-whitaker, p03-reyes, p04-kowalski) mirror
 * `bin/seed/FixturePatient.php` exactly. The three additional cohort-5
 * archetypes (p05-patel, p06-johnson, p07-nguyen) are demographics
 * fixtures owned by this file — the chart seed pipeline does not (yet)
 * include them, so an integration run of the live system would not
 * have a real chart to match against. The eval target stubs the
 * demographics fetch in both per-MR and experiment runs, so the
 * gap is invisible to the suite's assertions.
 *
 * Per-fixture-file overrides (DEMOGRAPHICS_BY_FIXTURE_PATH) handle the
 * reality that the cohort-5 fax-packet TIFFs and the W2 lab/intake
 * PDFs were authored independently and pin different identities for
 * the same archetype tag (e.g., the Chen lab PDF says
 * "Margaret L. Chen 1967-08-14" but the Chen fax-packet TIFF says
 * "Margaret Chen 1968-03-12"). Each static fixture is its own source of
 * truth — the override map lets the chart-side demographics align with
 * whatever each document encodes, instead of forcing every fixture for
 * an archetype to share one identity.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { CaseKind, ManifestEntry } from '../fixtures/regenerate-document-extraction.js';
import type { Demographics, SourceReference } from '../../src/snapshot/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURES_ROOT = join(HERE, '..', 'fixtures', 'document-extraction', 'source');
const MANIFEST_PATH = join(FIXTURES_ROOT, 'manifest.json');

interface ManifestFile {
    readonly version: number;
    readonly documents: readonly ManifestEntry[];
}

let cachedManifest: ManifestFile | null = null;

export const loadManifest = async (): Promise<ManifestFile> => {
    if (cachedManifest !== null) return cachedManifest;
    const buf = await readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(buf) as ManifestFile;
    cachedManifest = parsed;
    return parsed;
};

export const loadEntries = async (): Promise<readonly ManifestEntry[]> => {
    return (await loadManifest()).documents;
};

export const loadFixtureBytes = async (entry: ManifestEntry): Promise<Buffer> => {
    return readFile(join(FIXTURES_ROOT, entry.path));
};

/**
 * Stable archetype-keyed pid assignment. The eval target uses these
 * pids on the envelope; matching real-system pids is not required —
 * the production pipeline reads pid from the supervisor envelope, and
 * the eval target stubs the demographics fetch.
 */
const PID_BY_ARCHETYPE: Record<string, number> = Object.freeze({
    'p01-chen': 4001,
    'p02-whitaker': 4002,
    'p03-reyes': 4003,
    'p04-kowalski': 4004,
    'p05-patel': 4005,
    'p06-johnson': 4006,
    'p07-nguyen': 4007,
});

export const pidForArchetype = (archetype: string): number => {
    const pid = PID_BY_ARCHETYPE[archetype];
    if (pid === undefined) {
        throw new Error(`pidForArchetype: unknown archetype ${archetype}`);
    }
    return pid;
};

const dummySource = (): SourceReference => ({
    source_type: 'chart',
    source_id: 'fixture-chart',
    locator: {},
    quote: 'fixture',
});

interface DemographicsFixture {
    readonly displayName: string;
    readonly sex: 'male' | 'female' | 'other' | 'unknown';
    readonly dateOfBirth: string;
    readonly ageYears: number;
}

const DEMOGRAPHICS_BY_ARCHETYPE: Record<string, DemographicsFixture> = Object.freeze({
    'p01-chen': {
        displayName: 'Margaret L. Chen',
        sex: 'female',
        dateOfBirth: '1967-08-14',
        ageYears: 58,
    },
    'p02-whitaker': {
        displayName: 'James E. Whitaker',
        sex: 'male',
        dateOfBirth: '1958-11-03',
        ageYears: 67,
    },
    'p03-reyes': {
        displayName: 'Sofia M. Reyes',
        sex: 'female',
        dateOfBirth: '1983-12-19',
        ageYears: 42,
    },
    'p04-kowalski': {
        displayName: 'Robert Kowalski',
        sex: 'male',
        dateOfBirth: '1971-06-08',
        ageYears: 54,
    },
    'p05-patel': {
        displayName: 'Anita Patel',
        sex: 'female',
        dateOfBirth: '1979-03-22',
        ageYears: 47,
    },
    'p06-johnson': {
        displayName: 'Marcus Johnson',
        sex: 'male',
        dateOfBirth: '1962-09-11',
        ageYears: 63,
    },
    'p07-nguyen': {
        displayName: 'Linh Nguyen',
        sex: 'female',
        dateOfBirth: '1991-07-04',
        ageYears: 34,
    },
});

/**
 * Per-fixture-file overrides. The cohort-5 fax-packet TIFFs and the
 * W2 lab/intake PDFs were authored by different sources and pin
 * different identities for the same archetype tag. Each static
 * fixture is its own source of truth; this map records what each
 * physical document encodes so the chart-side demographics can match.
 *
 * Keys are manifest `path` values (relative to source/). Synthetic
 * PDFs (blank, prompt-injection, unrelated, corrupted) are absent
 * from the document content itself, so they have no override and
 * fall back to the archetype's default — `patient_match` never runs
 * on those because earlier nodes (vision/schemaValidate) refuse first.
 */
const DEMOGRAPHICS_BY_FIXTURE_PATH: Record<string, DemographicsFixture> = Object.freeze({
    'tiffs/p01-chen-fax-packet.tiff': {
        displayName: 'Margaret Chen',
        sex: 'female',
        dateOfBirth: '1968-03-12',
        ageYears: 58,
    },
    'tiffs/p02-whitaker-fax-packet.tiff': {
        displayName: 'James Whitaker',
        sex: 'male',
        dateOfBirth: '1958-11-22',
        ageYears: 67,
    },
    'tiffs/p03-reyes-fax-packet.tiff': {
        displayName: 'Sofia Reyes',
        sex: 'female',
        dateOfBirth: '1983-07-04',
        ageYears: 42,
    },
    'tiffs/p04-kowalski-fax-packet.tiff': {
        displayName: 'Robert Kowalski',
        sex: 'male',
        dateOfBirth: '1971-09-30',
        ageYears: 54,
    },
    'tiffs/p05-patel-fax-packet.tiff': {
        displayName: 'Aisha Patel',
        sex: 'female',
        dateOfBirth: '1991-06-15',
        ageYears: 34,
    },
    'tiffs/p06-johnson-fax-packet.tiff': {
        displayName: 'Marcus Johnson',
        sex: 'male',
        dateOfBirth: '1954-02-08',
        ageYears: 71,
    },
    'tiffs/p07-nguyen-fax-packet.tiff': {
        displayName: 'Olivia Nguyen',
        sex: 'female',
        dateOfBirth: '1997-10-19',
        ageYears: 28,
    },
    // Referral-letter DOCX identities. Each letter pins its own
    // patient-identifiers block (`RE: <name> | DOB: <m/d/y> | MRN: <id>`).
    'referrals/p01-chen-referral.docx': {
        displayName: 'Margaret Chen',
        sex: 'female',
        dateOfBirth: '1968-03-12',
        ageYears: 58,
    },
    'referrals/p02-whitaker-referral.docx': {
        displayName: 'James Whitaker',
        sex: 'male',
        dateOfBirth: '1958-11-22',
        ageYears: 67,
    },
    'referrals/p03-reyes-referral.docx': {
        displayName: 'Sofia Reyes',
        sex: 'female',
        dateOfBirth: '1983-07-04',
        ageYears: 42,
    },
});

export const demographicsForArchetype = (archetype: string): Demographics => {
    const fix = DEMOGRAPHICS_BY_ARCHETYPE[archetype];
    if (fix === undefined) {
        throw new Error(`demographicsForArchetype: unknown archetype ${archetype}`);
    }
    return {
        pid: pidForArchetype(archetype),
        uuid: `uuid-${archetype}`,
        displayName: fix.displayName,
        sex: fix.sex,
        dateOfBirth: fix.dateOfBirth,
        ageYears: fix.ageYears,
        source: dummySource(),
    };
};

/**
 * Case kinds that intentionally cross identities — patientMatch is
 * supposed to refuse these, so chart demographics must come from the
 * archetype (the envelope's chart) rather than the document's own
 * identity. Adversarial-wrong-patient is the canonical example: the
 * envelope is Kowalski but the document is Chen's lab PDF.
 */
const CROSS_IDENTITY_CASE_KINDS: ReadonlySet<CaseKind> = new Set<CaseKind>([
    'adversarial-wrong-patient',
    'referral-letter-wrong-patient',
]);

/**
 * Chart-side demographics for a manifest entry. For most cases this
 * is "what does the physical document say about its patient?" — the
 * fixture-file override takes precedence over the archetype default.
 * For `adversarial-wrong-patient`, the envelope's archetype (Kowalski)
 * wins so patientMatch can refuse against the document's actual
 * identity (Chen).
 */
export const chartDemographicsForCase = (entry: ManifestEntry): Demographics => {
    if (CROSS_IDENTITY_CASE_KINDS.has(entry.caseKind)) {
        return demographicsForArchetype(entry.patient.archetype);
    }
    const override = DEMOGRAPHICS_BY_FIXTURE_PATH[entry.path];
    if (override === undefined) {
        return demographicsForArchetype(entry.patient.archetype);
    }
    return {
        pid: pidForArchetype(entry.patient.archetype),
        uuid: `uuid-${entry.patient.archetype}`,
        displayName: override.displayName,
        sex: override.sex,
        dateOfBirth: override.dateOfBirth,
        ageYears: override.ageYears,
        source: dummySource(),
    };
};

/**
 * Document-side demographics — what the stub vision invoker should
 * emit for this case so its output matches what real vision would
 * extract from the physical document. For `adversarial-wrong-patient`
 * the document is Chen's lab PDF, so the document identity is Chen
 * even though the envelope is Kowalski.
 */
export const documentDemographicsForCase = (entry: ManifestEntry): Demographics => {
    if (entry.caseKind === 'adversarial-wrong-patient') {
        return demographicsForArchetype('p01-chen');
    }
    if (entry.caseKind === 'referral-letter-wrong-patient') {
        // Document is Reyes' referral; envelope is Kowalski. The
        // override on the referral's path returns Reyes' identity for
        // the document side, which is what the stub vision invoker
        // surfaces.
        const referralOverride = DEMOGRAPHICS_BY_FIXTURE_PATH[entry.path];
        if (referralOverride !== undefined) {
            return {
                pid: pidForArchetype('p03-reyes'),
                uuid: `uuid-p03-reyes`,
                displayName: referralOverride.displayName,
                sex: referralOverride.sex,
                dateOfBirth: referralOverride.dateOfBirth,
                ageYears: referralOverride.ageYears,
                source: dummySource(),
            };
        }
    }
    const override = DEMOGRAPHICS_BY_FIXTURE_PATH[entry.path];
    if (override === undefined) {
        return demographicsForArchetype(entry.patient.archetype);
    }
    return {
        pid: pidForArchetype(entry.patient.archetype),
        uuid: `uuid-${entry.patient.archetype}`,
        displayName: override.displayName,
        sex: override.sex,
        dateOfBirth: override.dateOfBirth,
        ageYears: override.ageYears,
        source: dummySource(),
    };
};
