import { createApp } from '../../src/server/index.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import type { BriefingRunner } from '../../src/server/briefingRunner.js';
import type { ConversationMessagesStore } from '../../src/state/conversationMessages.js';
import type { ConversationStore } from '../../src/state/conversationStore.js';
import { generateTestKey } from '../auth/testKeys.js';
import type { Hono } from 'hono';
import type { KeyLike } from 'jose';

export const TEST_ISSUER = 'https://emr.test/oauth2/default';
export const TEST_AUDIENCE = 'openemr-clinical-copilot-agent';

export interface AuthedApp {
    app: Hono;
    privateKey: KeyLike;
}

export interface AuthedAppOptions {
    readonly briefingRunner?: BriefingRunner;
    readonly resume?: {
        readonly conversationStore: ConversationStore;
        readonly conversationMessages: ConversationMessagesStore;
        readonly windowHours?: number;
    };
}

const stubBriefingRunner: BriefingRunner = () => Promise.resolve([]);

export const buildAuthedApp = async (options: AuthedAppOptions = {}): Promise<AuthedApp> => {
    const { privateKey, publicJwk } = await generateTestKey();
    const verify = createAgentJwtVerifier({
        keyResolver: createLocalKeyResolver([publicJwk]),
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
    });
    return {
        app: createApp({
            auth: { verify },
            briefingRunner: options.briefingRunner ?? stubBriefingRunner,
            ...(options.resume !== undefined
                ? {
                      resume: {
                          conversationStore: options.resume.conversationStore,
                          conversationMessages: options.resume.conversationMessages,
                          windowHours: options.resume.windowHours ?? 12,
                      },
                  }
                : {}),
        }),
        privateKey,
    };
};
