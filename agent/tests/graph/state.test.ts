import { describe, expect, it } from 'vitest';

import { BriefingStateAnnotation } from '../../src/graph/state.js';

describe('BriefingStateAnnotation', () => {
    it('declares the seven slots from the plan', () => {
        const spec = BriefingStateAnnotation.spec;
        const expected = [
            'envelope',
            'snapshot',
            'draft',
            'claimLedger',
            'verified',
            'formatted',
            'persisted',
        ] as const;
        for (const key of expected) {
            expect(spec).toHaveProperty(key);
        }
    });

    it('defaults snapshot/draft/claimLedger/verified/formatted/persisted to null', () => {
        // Each slot's spec entry is a factory `() => LastValue<T>`; the
        // `LastValue` carries `initialValueFactory: () => T`. Confirm the
        // factory exists and produces null so a partially-run graph state
        // is recognizable.
        const spec = BriefingStateAnnotation.spec;
        for (const key of ['snapshot', 'draft', 'claimLedger', 'verified', 'formatted', 'persisted']) {
            const factory = spec[key as keyof typeof spec];
            expect(typeof factory).toBe('function');
            const channel = (factory as unknown as () => { initialValueFactory?: () => unknown })();
            expect(typeof channel.initialValueFactory).toBe('function');
            expect(channel.initialValueFactory?.()).toBeNull();
        }
    });
});
