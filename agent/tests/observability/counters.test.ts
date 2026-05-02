import { describe, expect, it } from 'vitest';

import { createInMemoryCounters, createNoopCounters } from '../../src/observability/counters.js';

describe('inMemoryCounters', () => {
    it('increments per-clinician and per-patient briefing counts', () => {
        const counters = createInMemoryCounters();
        counters.recordBriefing({ clinicianId: 'u-1', patientId: 'p-1' });
        counters.recordBriefing({ clinicianId: 'u-1', patientId: 'p-1' });
        counters.recordBriefing({ clinicianId: 'u-1', patientId: 'p-2' });
        counters.recordBriefing({ clinicianId: 'u-2', patientId: 'p-2' });

        const snap = counters.snapshot();
        expect(snap.briefingsByClinician['u-1']).toBe(3);
        expect(snap.briefingsByClinician['u-2']).toBe(1);
        expect(snap.briefingsByPatient['p-1']).toBe(2);
        expect(snap.briefingsByPatient['p-2']).toBe(2);
        expect(snap.totalBriefings).toBe(4);
    });

    it('records per-tool call counts and accumulated latency', () => {
        const counters = createInMemoryCounters();
        counters.recordToolCall({ tool: 'getPrescriptions', latencyMs: 120 });
        counters.recordToolCall({ tool: 'getPrescriptions', latencyMs: 80 });
        counters.recordToolCall({ tool: 'getRecentLabs', latencyMs: 200 });

        const snap = counters.snapshot();
        expect(snap.toolCalls['getPrescriptions']?.count).toBe(2);
        expect(snap.toolCalls['getPrescriptions']?.totalLatencyMs).toBe(200);
        expect(snap.toolCalls['getRecentLabs']?.count).toBe(1);
        expect(snap.toolCalls['getRecentLabs']?.totalLatencyMs).toBe(200);
    });

    it('accumulates token usage and dollar cost', () => {
        const counters = createInMemoryCounters();
        counters.recordModelUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.0105,
        });
        counters.recordModelUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 2000,
            outputTokens: 1000,
            costUsd: 0.021,
        });

        const snap = counters.snapshot();
        const usage = snap.modelUsage['claude-sonnet-4-6']!;
        expect(usage.inputTokens).toBe(3000);
        expect(usage.outputTokens).toBe(1500);
        expect(usage.costUsd).toBeCloseTo(0.0315, 6);
        expect(usage.calls).toBe(2);
    });

    it('records verification outcomes and prompt-injection counts', () => {
        const counters = createInMemoryCounters();
        counters.recordVerification({
            passed: true,
            accepted: 5,
            rejected: 0,
            promptInjections: 0,
        });
        counters.recordVerification({
            passed: false,
            accepted: 3,
            rejected: 2,
            promptInjections: 1,
        });

        const snap = counters.snapshot();
        expect(snap.verification.passed).toBe(1);
        expect(snap.verification.failed).toBe(1);
        expect(snap.verification.acceptedClaims).toBe(8);
        expect(snap.verification.rejectedClaims).toBe(2);
        expect(snap.verification.promptInjections).toBe(1);
    });

    it('snapshot returns a defensive copy, mutations do not leak', () => {
        const counters = createInMemoryCounters();
        counters.recordBriefing({ clinicianId: 'u-1', patientId: 'p-1' });
        const snap = counters.snapshot();
        snap.briefingsByClinician['u-1'] = 999;

        const fresh = counters.snapshot();
        expect(fresh.briefingsByClinician['u-1']).toBe(1);
    });
});

describe('noopCounters', () => {
    it('accepts every call and returns an empty snapshot', () => {
        const counters = createNoopCounters();
        counters.recordBriefing({ clinicianId: 'u-1', patientId: 'p-1' });
        counters.recordToolCall({ tool: 'getPrescriptions', latencyMs: 120 });
        counters.recordModelUsage({
            model: 'claude-sonnet-4-6',
            inputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.01,
        });
        counters.recordVerification({
            passed: true,
            accepted: 1,
            rejected: 0,
            promptInjections: 0,
        });

        const snap = counters.snapshot();
        expect(snap.totalBriefings).toBe(0);
        expect(snap.briefingsByClinician).toEqual({});
        expect(snap.briefingsByPatient).toEqual({});
        expect(snap.toolCalls).toEqual({});
        expect(snap.modelUsage).toEqual({});
        expect(snap.verification.passed).toBe(0);
    });
});
