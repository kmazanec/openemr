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
                        medications: [
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

        const snapshot = entry['snapshot'] as { medications: Record<string, unknown>[] };
        for (const med of snapshot.medications) {
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
});
