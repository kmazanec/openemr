import { describe, expect, it } from 'vitest';

import {
    DEFAULT_TRANSIENT_PREFIX,
    SpacesEnvError,
    parseSpacesEnv,
} from '../../src/config/spacesEnv.js';

const validEnv = (): Record<string, string> => ({
    SPACES_BUCKET: 'cdn.biograph.dev',
    SPACES_REGION: 'nyc3',
    SPACES_OPENEMR_KEY: 'oe-key',
    SPACES_OPENEMR_SECRET: 'oe-secret',
    SPACES_AGENT_KEY: 'agent-key',
    SPACES_AGENT_SECRET: 'agent-secret',
    SPACES_TRANSIENT_PREFIX: 'transient',
});

describe('parseSpacesEnv', () => {
    it('parses a fully-populated env into the strict-typed DTO', () => {
        const env = parseSpacesEnv(validEnv());
        expect(env.bucket).toBe('cdn.biograph.dev');
        expect(env.region).toBe('nyc3');
        expect(env.endpoint).toBe('https://nyc3.digitaloceanspaces.com');
        expect(env.openemr.accessKey).toBe('oe-key');
        expect(env.openemr.secretKey).toBe('oe-secret');
        expect(env.agent.accessKey).toBe('agent-key');
        expect(env.agent.secretKey).toBe('agent-secret');
        expect(env.transientPrefix).toBe('transient');
    });

    it('falls back to the default transient prefix when the var is empty', () => {
        const raw = validEnv();
        delete raw['SPACES_TRANSIENT_PREFIX'];
        const env = parseSpacesEnv(raw);
        expect(env.transientPrefix).toBe(DEFAULT_TRANSIENT_PREFIX);
    });

    it('builds the DigitalOcean Spaces endpoint from the region', () => {
        const env = parseSpacesEnv({ ...validEnv(), SPACES_REGION: 'ams3' });
        expect(env.endpoint).toBe('https://ams3.digitaloceanspaces.com');
    });

    it.each([
        ['SPACES_BUCKET'],
        ['SPACES_REGION'],
        ['SPACES_OPENEMR_KEY'],
        ['SPACES_OPENEMR_SECRET'],
        ['SPACES_AGENT_KEY'],
        ['SPACES_AGENT_SECRET'],
    ])('throws SpacesEnvError when %s is missing', (missingVar) => {
        const raw = validEnv();
        delete raw[missingVar];
        expect(() => parseSpacesEnv(raw)).toThrow(SpacesEnvError);
        expect(() => parseSpacesEnv(raw)).toThrow(new RegExp(missingVar));
    });

    it.each([
        ['SPACES_BUCKET'],
        ['SPACES_REGION'],
        ['SPACES_OPENEMR_KEY'],
        ['SPACES_OPENEMR_SECRET'],
        ['SPACES_AGENT_KEY'],
        ['SPACES_AGENT_SECRET'],
    ])('throws SpacesEnvError when %s is whitespace-only', (whitespaceVar) => {
        const raw = validEnv();
        raw[whitespaceVar] = '   ';
        expect(() => parseSpacesEnv(raw)).toThrow(SpacesEnvError);
    });

    it('returns frozen / readonly objects so callers cannot mutate config in place', () => {
        const env = parseSpacesEnv(validEnv());
        expect(Object.isFrozen(env)).toBe(true);
        expect(Object.isFrozen(env.openemr)).toBe(true);
        expect(Object.isFrozen(env.agent)).toBe(true);
    });

    it('strips leading and trailing whitespace from values', () => {
        const env = parseSpacesEnv({ ...validEnv(), SPACES_BUCKET: '  bkt  ' });
        expect(env.bucket).toBe('bkt');
    });

    it('rejects a transient prefix containing a slash — keys are joined with explicit separators', () => {
        expect(() =>
            parseSpacesEnv({ ...validEnv(), SPACES_TRANSIENT_PREFIX: 'tr/sub' }),
        ).toThrow(/SPACES_TRANSIENT_PREFIX/);
    });
});
