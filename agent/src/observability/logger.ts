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
];

const buildRedactPaths = (): string[] => {
    const paths: string[] = [];
    for (const leaf of PHI_LEAFS) {
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
