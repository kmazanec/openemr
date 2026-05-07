import { createApp } from '../../src/server/index.js';
import { createLocalKeyResolver } from '../../src/auth/jwks.js';
import { createAgentJwtVerifier } from '../../src/auth/verify.js';
import type { BriefingRunner } from '../../src/server/briefingRunner.js';
import type { PipelineRunner } from '../../src/server/routes/extract.js';
import type { ConversationMessagesStore } from '../../src/state/conversationMessages.js';
import type { ConversationStore } from '../../src/state/conversationStore.js';
import type { ExtractionArtifactStore } from '../../src/state/extractionArtifacts.js';
import type { ScheduleBriefingsLog } from '../../src/state/scheduleBriefings.js';
import type { OpenEmrPromoteClient } from '../../src/storage/openemrPromoteClient.js';
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
    /**
     * §4.6 / §4.7 conversation read-side wiring. Older tests still use
     * the field name `resume` from the §4.6 era; new tests can use
     * `conversationApi`. Either name accepted.
     */
    readonly conversationApi?: {
        readonly conversationStore: ConversationStore;
        readonly conversationMessages: ConversationMessagesStore;
        readonly resumeWindowHours?: number;
    };
    readonly resume?: {
        readonly conversationStore: ConversationStore;
        readonly conversationMessages: ConversationMessagesStore;
        readonly windowHours?: number;
    };
    readonly scheduleBriefingsLog?: ScheduleBriefingsLog;
    readonly pipeline?: PipelineRunner;
    readonly extractionArtifactStore?: Partial<
        Pick<ExtractionArtifactStore, 'recordDisposition' | 'findArtifactById'>
    >;
    readonly promoteClient?: OpenEmrPromoteClient;
}

const stubBriefingRunner: BriefingRunner = () => Promise.resolve([]);

export const buildAuthedApp = async (options: AuthedAppOptions = {}): Promise<AuthedApp> => {
    const { privateKey, publicJwk } = await generateTestKey();
    const verify = createAgentJwtVerifier({
        keyResolver: createLocalKeyResolver([publicJwk]),
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
    });
    const conversationApi = options.conversationApi ?? (options.resume !== undefined
        ? {
              conversationStore: options.resume.conversationStore,
              conversationMessages: options.resume.conversationMessages,
              resumeWindowHours: options.resume.windowHours,
          }
        : undefined);
    return {
        app: createApp({
            auth: { verify },
            briefingRunner: options.briefingRunner ?? stubBriefingRunner,
            ...(conversationApi !== undefined
                ? {
                      conversationApi: {
                          conversationStore: conversationApi.conversationStore,
                          conversationMessages: conversationApi.conversationMessages,
                          resumeWindowHours: conversationApi.resumeWindowHours ?? 12,
                      },
                  }
                : {}),
            ...(options.scheduleBriefingsLog !== undefined
                ? { scheduleBriefingsLog: options.scheduleBriefingsLog }
                : {}),
            ...(options.pipeline !== undefined
                ? { pipeline: options.pipeline }
                : {}),
            ...(options.extractionArtifactStore !== undefined
                ? { extractionArtifactStore: options.extractionArtifactStore }
                : {}),
            ...(options.promoteClient !== undefined
                ? { promoteClient: options.promoteClient }
                : {}),
        }),
        privateKey,
    };
};
