import { describe, expect, it } from 'vitest';

import type { Run } from 'langsmith';

import { caseIdFromRun, parseArgs } from './rebaseline.js';

describe('parseArgs', () => {
    it('parses the happy path: --confirm --commit-message "<text>"', () => {
        const parsed = parseArgs(['--confirm', '--commit-message', 'rebaseline after model upgrade']);
        expect(parsed.confirm).toBe(true);
        expect(parsed.commitMessage).toBe('rebaseline after model upgrade');
    });

    it('parses --commit-message=<text> equals form', () => {
        const parsed = parseArgs(['--confirm', '--commit-message=rubric tightening']);
        expect(parsed.confirm).toBe(true);
        expect(parsed.commitMessage).toBe('rubric tightening');
    });

    it('omitting --confirm leaves it false', () => {
        const parsed = parseArgs(['--commit-message', 'foo']);
        expect(parsed.confirm).toBe(false);
        expect(parsed.commitMessage).toBe('foo');
    });

    it('omitting --commit-message leaves it null', () => {
        const parsed = parseArgs(['--confirm']);
        expect(parsed.commitMessage).toBeNull();
    });

    it('throws when --commit-message is at the end with no value', () => {
        expect(() => parseArgs(['--confirm', '--commit-message'])).toThrowError(
            /requires a non-empty argument/,
        );
    });
});

describe('caseIdFromRun', () => {
    const stubRun = (inputs: Record<string, unknown>): Run => ({
        id: 'run-id',
        name: 'r',
        run_type: 'chain',
        inputs,
    });

    it('document-extraction: pulls inputs.caseId verbatim', () => {
        const id = caseIdFromRun(
            'clinical-copilot-document-extraction-v1',
            stubRun({ caseId: 'lab-chen-lipid-panel' }),
        );
        expect(id).toBe('lab-chen-lipid-panel');
    });

    it('conversational-graph: pulls inputs.group verbatim', () => {
        const id = caseIdFromRun(
            'clinical-copilot-conversational-graph-v2',
            stubRun({ group: 'multi-retriever' }),
        );
        expect(id).toBe('multi-retriever');
    });

    it('end-to-end: pulls inputs.scenario verbatim', () => {
        const id = caseIdFromRun(
            'clinical-copilot-end-to-end-v1',
            stubRun({ scenario: 'lab-plus-chart' }),
        );
        expect(id).toBe('lab-plus-chart');
    });

    it('briefing-graph: archetype:<key> for archetype kind', () => {
        const id = caseIdFromRun(
            'clinical-copilot-briefing-graph-v1',
            stubRun({ caseKind: 'archetype', archetype: 'diabetic' }),
        );
        expect(id).toBe('archetype:diabetic');
    });

    it('briefing-graph: lab-trend:<key> for lab-trend kind', () => {
        const id = caseIdFromRun(
            'clinical-copilot-briefing-graph-v1',
            stubRun({ caseKind: 'lab-trend', scenario: 'a1c_trend_up' }),
        );
        expect(id).toBe('lab-trend:a1c_trend_up');
    });

    it('briefing-graph: morning-prep:<id> for morning-prep kind', () => {
        const id = caseIdFromRun(
            'clinical-copilot-briefing-graph-v1',
            stubRun({ caseKind: 'morning-prep', appointmentId: 'apt-uc5-12' }),
        );
        expect(id).toBe('morning-prep:apt-uc5-12');
    });

    it('returns null when the run has no recognizable case id', () => {
        const id = caseIdFromRun(
            'clinical-copilot-briefing-graph-v1',
            stubRun({ caseKind: 'archetype' }),
        );
        expect(id).toBeNull();
    });

    it('returns null for an unknown dataset name', () => {
        const id = caseIdFromRun('clinical-copilot-unknown-v1', stubRun({ caseId: 'x' }));
        expect(id).toBeNull();
    });
});
