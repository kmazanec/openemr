import { describe, expect, it } from 'vitest';

import { AgentHttpError, AgentNetworkError } from '../../src/tools/agentHttp.js';
import { getPrescriptionProvenance } from '../../src/tools/getPrescriptionProvenance.js';

import { mockAgentHttpRejecting, mockAgentHttpResolving } from './buildMockClient.js';

const TOKEN = 'tok';
const SITE = 'default';
const PID = 42;
const MED_ID = 7001;
const BASE = 'http://openemr';

const narrowResponse = {
    provenance: {
        prescriptionId: 7001,
        drugName: 'lisinopril',
        prescriber: 'Patel, Maya',
        prescribingDate: '2026-03-20',
        indication: 'new-onset hypertension',
        doseAdjustments: [{ dose: '10 mg', date: '2026-03-20' }],
    },
};

const callOpts = () => ({
    token: TOKEN,
    siteId: SITE,
    pid: PID,
    prescriptionId: MED_ID,
    openEmrBaseUrl: BASE,
});

describe('getPrescriptionProvenance', () => {
    it('GETs the provenance endpoint with site + pid + prescriptionId', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);

        const out = await getPrescriptionProvenance({ client, ...callOpts() });

        expect(get).toHaveBeenCalledTimes(1);
        const call = get.mock.calls[0]?.[0] as { url: string; token: string };
        expect(call.token).toBe(TOKEN);
        expect(call.url).toBe(
            `${BASE}/interface/modules/custom_modules/oe-module-clinical-copilot/public/snapshot/prescription_provenance.php?site=${SITE}&pid=${String(PID)}&prescriptionId=${String(MED_ID)}`,
        );
        expect(out.kind).toBe('ok');
        if (out.kind !== 'ok') return;
        expect(out.provenance?.prescriptionId).toBe('7001');
        expect(out.provenance?.drugName).toBe('lisinopril');
        expect(out.provenance?.indication).toBe('new-onset hypertension');
    });

    it('treats 404 as "no record found" (provenance: null), not a fail-open gap', async () => {
        // The branch needs a deterministic answer when the prescription
        // id can't be resolved; rendering a "no record" connector is
        // very different from a transient endpoint outage.
        const { client } = mockAgentHttpRejecting(new AgentHttpError(404, ''));
        const out = await getPrescriptionProvenance({ client, ...callOpts() });
        expect(out).toEqual({ kind: 'ok', provenance: null });
    });

    it('fails open with a gap on 503', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(503, ''));
        const out = await getPrescriptionProvenance({ client, ...callOpts() });
        expect(out.kind).toBe('gap');
    });

    it('fails open with a gap on network error', async () => {
        const { client } = mockAgentHttpRejecting(new AgentNetworkError('unreachable'));
        const out = await getPrescriptionProvenance({ client, ...callOpts() });
        expect(out.kind).toBe('gap');
        if (out.kind !== 'gap') return;
        expect(out.reason).toBe('endpoint-unreachable');
    });

    it('throws on 401 (auth failure must surface, not become a gap)', async () => {
        const { client } = mockAgentHttpRejecting(new AgentHttpError(401, ''));
        await expect(
            getPrescriptionProvenance({ client, ...callOpts() }),
        ).rejects.toBeInstanceOf(AgentHttpError);
    });

    it('rejects a non-positive prescriptionId before any network call', async () => {
        const { client, get } = mockAgentHttpResolving(narrowResponse);
        await expect(
            getPrescriptionProvenance({ client, ...callOpts(), prescriptionId: 0 }),
        ).rejects.toThrow(/prescriptionId must be a positive integer/);
        expect(get).not.toHaveBeenCalled();
    });
});
