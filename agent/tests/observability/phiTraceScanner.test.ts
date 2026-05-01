import { describe, expect, it } from 'vitest';

import { scanForPhi } from '../../src/observability/phiTraceScanner.js';

describe('scanForPhi', () => {
    it('reports a finding when a PHI-shaped key appears anywhere in the tree', () => {
        const findings = scanForPhi({
            inputs: {
                messages: [{ content: 'hello', mrn: '[REDACTED]' }],
            },
        });
        expect(findings).toHaveLength(1);
        expect(findings[0]!.kind).toBe('phi-key');
        expect(findings[0]!.match).toBe('mrn');
        expect(findings[0]!.path).toBe('inputs.messages[0].mrn');
    });

    it('reports SSN-shaped strings via pattern match', () => {
        const findings = scanForPhi({
            inputs: { content: 'patient ssn 123-45-6789 passed in error' },
        });
        expect(findings.find((f) => f.kind === 'phi-pattern' && f.match === 'ssn')).toBeDefined();
    });

    it('reports canary tokens supplied by the caller', () => {
        const findings = scanForPhi(
            { inputs: { content: 'Mrs. Patel is here for diabetes follow-up' } },
            { canaries: ['Patel', 'Maya'] },
        );
        const patelHit = findings.find((f) => f.kind === 'phi-canary' && f.match === 'Patel');
        expect(patelHit).toBeDefined();
    });

    it('returns no findings for a clean trace shape', () => {
        const findings = scanForPhi(
            {
                inputs: { messages: [{ role: 'system', content: 'Briefing format rules.' }] },
                outputs: {
                    segments: [{ text: '[REDACTED — patient name]', claimIds: ['c-1'] }],
                },
                metadata: { latency_ms: 250, claims_accepted: 3, claims_rejected: 0 },
            },
            { canaries: ['Patel'] },
        );
        expect(findings).toEqual([]);
    });

    it('reports both key and pattern when the same node leaks twice', () => {
        const findings = scanForPhi({
            patient: { mrn: 'MRN-123456' },
        });
        const kinds = findings.map((f) => f.kind).sort();
        expect(kinds).toEqual(['phi-key', 'phi-pattern']);
    });

    it('handles deeply nested traces without stack overflow', () => {
        let node: Record<string, unknown> = { content: 'leaf' };
        for (let i = 0; i < 200; i += 1) {
            node = { wrap: node };
        }
        // The scanner must terminate (we cap at 50 levels) and not throw.
        const findings = scanForPhi(node);
        expect(findings).toEqual([]);
    });

    it('walks both object and array children and records full paths', () => {
        const findings = scanForPhi({
            runs: [
                { inputs: { ssn: '123-45-6789' } },
                { inputs: { ssn: '987-65-4321' } },
            ],
        });
        const paths = findings.filter((f) => f.kind === 'phi-key').map((f) => f.path).sort();
        expect(paths).toEqual(['runs[0].inputs.ssn', 'runs[1].inputs.ssn']);
    });
});
