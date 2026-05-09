import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Writable } from 'node:stream';

const PHI_LEAFS = [
    'firstName',
    'lastName',
    'name',
    'fullName',
    'patientName',
    'prescriber',
    'dob',
    'dateOfBirth',
    'ssn',
    'mrn',
    'address',
    'phone',
    'email',
    'prompt',
    'completion',
    'response',
    'message',
    'notes',
    // patientMatch dev-diagnostics + projections. The pipeline's
    // patient-match step logs these alongside score/reason on a
    // confident mismatch; without redaction the dev-only Pino log
    // captured raw extracted vs. chart demographics in plain text.
    'extractedName',
    'extractedDob',
    'extractedDateOfBirth',
    'chartDisplayName',
    'chartDateOfBirth',
    'chartName',
    'displayName',
    // Free-text user input + payload fields that reach Pino. `question`
    // and `text` are user-typed conversation turns; `documentText`
    // carries raw DOCX bytes when the referral-letter pipeline runs in
    // text mode; `rawValue` shows up in priorTurnContext citation
    // values; `bodyPreview` is the upstream error-response preview the
    // snapshot/promote clients carry on their HTTP error classes.
    //
    // `reason` and `narration` are deliberately NOT redacted globally —
    // they're typed enum/short-string tags in many internal call sites
    // (e.g. `{reason: 'rate_limited'}`), and global redaction would
    // hide load-bearing debug signal. The LLM-emitted variants (the
    // supervisor's `decision.reason` / `decision.narration`) leak into
    // LangSmith metadata, not Pino, and are scrubbed at that site.
    'question',
    'text',
    'documentText',
    'rawValue',
    'bodyPreview',
];

/**
 * §B.4 vision-payload paths. Image bytes themselves never reach the
 * logger (they're streamed by URL), but signed URLs leak the document
 * UUID + Spaces credentials, and the extraction object holds
 * demographics + lab values. Redact at the Pino layer so the local
 * debug log stays PHI-safe even when the temporary
 * `AGENT_DEBUG_VISION_INPUTS=1` flag is set.
 *
 * These leafs are scoped narrowly (no wildcarded match on every
 * possible parent path) because they're context-specific to the
 * pipeline: a generic `signedUrl` field on a non-vision payload would
 * be just as PHI-bearing.
 */
const VISION_PHI_LEAFS = ['signedUrl', 'extraction'];

const buildRedactPaths = (): string[] => {
    const paths: string[] = [];
    for (const leaf of [...PHI_LEAFS, ...VISION_PHI_LEAFS]) {
        paths.push(leaf);
        paths.push(`*.${leaf}`);
        paths.push(`*.*.${leaf}`);
        paths.push(`*[*].${leaf}`);
        paths.push(`*.*[*].${leaf}`);
    }
    return paths;
};

const REDACT_PATHS = buildRedactPaths();

const isProd = (): boolean => process.env['NODE_ENV'] === 'production';

const defaultLevel = (): string => process.env['LOG_LEVEL'] ?? (isProd() ? 'info' : 'debug');

interface CreateLoggerOptions {
    /** Override the destination stream — used in tests. */
    stream?: Writable;
    /** Force pino-pretty on/off. Defaults to TTY + non-prod. */
    pretty?: boolean;
}

const baseOptions = (component: string): LoggerOptions => ({
    level: defaultLevel(),
    base: { component },
    redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

export const createLogger = (component: string, options: CreateLoggerOptions = {}): Logger => {
    const usePretty = options.pretty ?? (!isProd() && process.stdout.isTTY === true);
    const opts = baseOptions(component);

    if (options.stream) {
        return pino(opts, options.stream);
    }
    if (usePretty) {
        return pino({
            ...opts,
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
        });
    }
    return pino(opts);
};
