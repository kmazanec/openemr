import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';

import { createLogger } from '../../src/observability/logger.js';

const captureLogs = (
    fn: (logger: ReturnType<typeof createLogger>) => void,
): Record<string, unknown>[] => {
    const lines: string[] = [];
    const sink = new Writable({
        write(chunk: Buffer | string, _encoding, cb) {
            lines.push(chunk.toString());
            cb();
        },
    });
    const logger = createLogger('test', { stream: sink, pretty: false });
    fn(logger);
    return lines
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => line.split('\n').filter((s) => s.trim().length > 0))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe('logger', () => {
    it('emits structured JSON with the component tag', () => {
        const entries = captureLogs((logger) => {
            logger.info({ requestId: 'req-1' }, 'hello');
        });

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            level: 30,
            msg: 'hello',
            component: 'test',
            requestId: 'req-1',
        });
    });

    it('redacts PHI-shaped top-level fields', () => {
        const entries = captureLogs((logger) => {
            logger.info(
                {
                    firstName: 'Maya',
                    lastName: 'Patel',
                    dob: '1968-04-12',
                    ssn: '123-45-6789',
                    mrn: 'MRN-99',
                    phone: '555-0100',
                    email: 'maya@example.com',
                    address: '1 Main St',
                    safe: 'keep-me',
                },
                'patient touched',
            );
        });

        const entry = entries[0]!;
        expect(entry['firstName']).toBe('[REDACTED]');
        expect(entry['lastName']).toBe('[REDACTED]');
        expect(entry['dob']).toBe('[REDACTED]');
        expect(entry['ssn']).toBe('[REDACTED]');
        expect(entry['mrn']).toBe('[REDACTED]');
        expect(entry['phone']).toBe('[REDACTED]');
        expect(entry['email']).toBe('[REDACTED]');
        expect(entry['address']).toBe('[REDACTED]');
        expect(entry['safe']).toBe('keep-me');
    });

    it('redacts PHI fields nested inside arrays and objects', () => {
        const entries = captureLogs((logger) => {
            logger.info(
                {
                    patient: { firstName: 'Maya', mrn: 'MRN-99' },
                    snapshot: {
                        prescriptions: [
                            { name: 'metformin', prescriber: 'Dr Patel' },
                            { name: 'lisinopril', prescriber: 'Dr Smith' },
                        ],
                    },
                },
                'snapshot built',
            );
        });

        const entry = entries[0]!;
        const patient = entry['patient'] as Record<string, unknown>;
        expect(patient['firstName']).toBe('[REDACTED]');
        expect(patient['mrn']).toBe('[REDACTED]');

        const snapshot = entry['snapshot'] as { prescriptions: Record<string, unknown>[] };
        for (const med of snapshot.prescriptions) {
            expect(med['prescriber']).toBe('[REDACTED]');
        }
    });

    it('redacts prompt and completion bodies', () => {
        const entries = captureLogs((logger) => {
            logger.info(
                {
                    prompt: 'You are a clinical co-pilot. Patient Maya Patel...',
                    completion: 'Maya has type 2 diabetes...',
                    response: 'Briefing: ...',
                    message: 'free-text from clinician',
                },
                'llm call',
            );
        });

        const entry = entries[0]!;
        expect(entry['prompt']).toBe('[REDACTED]');
        expect(entry['completion']).toBe('[REDACTED]');
        expect(entry['response']).toBe('[REDACTED]');
        expect(entry['message']).toBe('[REDACTED]');
    });

    it('redacts patientMatch dev-diagnostic fields', () => {
        // The pipeline's patientMatch node logs these alongside the
        // mismatch reason on a confident-mismatch refusal. Pre-fix the
        // dev Pino log captured `{"extractedName":"CHEN, MARGARET","dob":...}`
        // verbatim. Pin every leaf the diagnostic helper emits.
        const entries = captureLogs((logger) => {
            logger.warn(
                {
                    documentUuid: 'd-1',
                    pid: 1,
                    mismatchReason: 'name+dob',
                    extractedName: 'CHEN, MARGARET',
                    extractedDob: '1967-08-14',
                    extractedDateOfBirth: '1967-08-14',
                    chartDisplayName: 'Belford, Phil',
                    chartDateOfBirth: '1972-02-09',
                    chartName: 'Belford, Phil',
                    displayName: 'Belford, Phil',
                },
                'patientMatch: confident mismatch — refusing extraction',
            );
        });

        const entry = entries[0]!;
        expect(entry['extractedName']).toBe('[REDACTED]');
        expect(entry['extractedDob']).toBe('[REDACTED]');
        expect(entry['extractedDateOfBirth']).toBe('[REDACTED]');
        expect(entry['chartDisplayName']).toBe('[REDACTED]');
        expect(entry['chartDateOfBirth']).toBe('[REDACTED]');
        expect(entry['chartName']).toBe('[REDACTED]');
        expect(entry['displayName']).toBe('[REDACTED]');
        expect(entry['mismatchReason']).toBe('name+dob');
        expect(entry['documentUuid']).toBe('d-1');
        expect(entry['pid']).toBe(1);
    });

    it('redacts free-text user turns and payload preview fields', () => {
        // `question` and `text` are user-typed conversation turns;
        // `documentText` carries raw DOCX bytes; `rawValue` is
        // priorTurnContext citation values; `bodyPreview` is the
        // upstream-error preview on snapshot/promote HTTP error classes.
        const entries = captureLogs((logger) => {
            logger.info(
                {
                    question: 'What did Phil mention about lisinopril?',
                    text: 'Patient reports new chest pain at 2am.',
                    documentText: 'Patient: Margaret Chen DOB: 1967-08-14',
                    rawValue: 'CHEN, MARGARET — DOB 1967-08-14',
                    bodyPreview: '<html>Internal error: pid=104 user=...',
                },
                'mixed PHI surfaces',
            );
        });

        const entry = entries[0]!;
        expect(entry['question']).toBe('[REDACTED]');
        expect(entry['text']).toBe('[REDACTED]');
        expect(entry['documentText']).toBe('[REDACTED]');
        expect(entry['rawValue']).toBe('[REDACTED]');
        expect(entry['bodyPreview']).toBe('[REDACTED]');
    });

    it('does NOT globally redact `reason` and `narration` — used as enum tags in many call sites', () => {
        // Internal error-classification tags like `{reason: 'rate_limited'}`
        // and supervisor `narration` short-strings are debugging
        // load-bearing. The LLM-emitted variants reach LangSmith
        // metadata via setRunMetadata, NOT Pino — that channel is
        // scrubbed at the supervisor metadata-write site. Pin this
        // explicitly so a future contributor doesn't add them to
        // PHI_LEAFS without surveying call sites.
        const entries = captureLogs((logger) => {
            logger.warn(
                {
                    reason: 'rate_limited',
                    narration: 'Pulling chart snapshot…',
                },
                'chart-docs discovery unavailable',
            );
        });

        const entry = entries[0]!;
        expect(entry['reason']).toBe('rate_limited');
        expect(entry['narration']).toBe('Pulling chart snapshot…');
    });
});
