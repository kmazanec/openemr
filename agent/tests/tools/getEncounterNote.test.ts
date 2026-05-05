import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getEncounterNote } from '../../src/tools/getEncounterNote.js';

import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const ENCOUNTER_ID = 99;
const BASE = 'http://openemr';

const narrowResponse = {
    notes: [
        {
            encounterId: '99',
            noteId: '7',
            noteDate: '2026-04-15',
            subjective: 'Pt reports good adherence to current antihypertensives.',
            objective: 'BP 138/82, HR regular.',
            assessment: 'Hypertension — at goal on current regimen.',
            plan: 'Continue meds. Recheck BP in 3 months.',
            source: {
                source_type: 'chart',
                source_id: '7',
                locator: { field: 'documentReference.text' },
                quote: 'note 7',
            },
        },
    ],
};

describe('getEncounterNote (narrow conversational tool)', () => {
    it('GETs the encounter-note endpoint with site, pid, encounter_id', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const result = await getEncounterNote({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            encounterId: ENCOUNTER_ID,
            openEmrBaseUrl: BASE,
        });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string };
        const url = new URL(call.url);
        expect(url.pathname).toBe(
            '/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/encounter-note.php',
        );
        expect(url.searchParams.get('site')).toBe(SITE);
        expect(url.searchParams.get('pid')).toBe(String(PID));
        expect(url.searchParams.get('encounter_id')).toBe(String(ENCOUNTER_ID));

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.notes).toHaveLength(1);
            expect(result.notes[0]!.assessment).toBe('Hypertension — at goal on current regimen.');
            expect(result.notes[0]!.encounterId).toBe('99');
        }
    });

    it('returns an explicit gap when the endpoint returns 5xx', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));

        const result = await getEncounterNote({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            encounterId: ENCOUNTER_ID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
        if (result.kind === 'gap') {
            expect(result.reason).toBe('endpoint-unavailable');
            expect(result.message).toMatch(/encounter note.*not available/i);
        }
    });

    it('returns an explicit gap when the endpoint is unreachable', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));

        const result = await getEncounterNote({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            encounterId: ENCOUNTER_ID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('gap');
    });

    it('rethrows on auth errors (401/403) instead of returning a gap', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(403, ''));
        await expect(
            getEncounterNote({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                encounterId: ENCOUNTER_ID,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('returns an empty notes array as a real result, not a gap', async () => {
        const { client } = mockAgentHttpResolving({ notes: [] });

        const result = await getEncounterNote({
            client,
            token: TOKEN,
            siteId: SITE,
            pid: PID,
            encounterId: ENCOUNTER_ID,
            openEmrBaseUrl: BASE,
        });

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
            expect(result.notes).toEqual([]);
        }
    });

    it('throws on non-positive encounterId', async () => {
        const { client } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getEncounterNote({
                client,
                token: TOKEN,
                siteId: SITE,
                pid: PID,
                encounterId: 0,
                openEmrBaseUrl: BASE,
            }),
        ).rejects.toThrow(/encounterId/);
    });
});
