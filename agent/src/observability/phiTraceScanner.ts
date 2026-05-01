/**
 * §6.1: PHI scanner for LangSmith trace bodies. The scanner walks any
 * object / array / string tree (a captured trace, a recorded fixture, or
 * a live `Run` from `langsmith.Client.listRuns`) and reports any place
 * a PHI-shaped key or value appears.
 *
 * Two complementary signals:
 *   - **Key-shaped**: a key that names PHI leaks even if the value was
 *     redacted (e.g. an `mrn` key in an LLM trace input means we built a
 *     prompt object with PHI-named structure even if `LANGSMITH_HIDE_*`
 *     blanked the value).
 *   - **Value-shaped**: regex patterns for SSN, MRN-prefix, etc., plus
 *     a configurable canary list of known fixture identifiers (the seed
 *     pipeline writes patient names like 'Maya' / 'Patel' that should
 *     never appear in a trace body).
 */

export interface PhiFinding {
    /** JSON-pointer-ish path to the offending node (e.g. `inputs.messages[0].content`). */
    readonly path: string;
    /** What kind of leak this finding is. */
    readonly kind: 'phi-key' | 'phi-pattern' | 'phi-canary';
    /** What we matched on (key name, pattern label, or canary token). */
    readonly match: string;
}

export interface PhiScanOptions {
    /**
     * Keys whose presence in the tree counts as a leak. Defaults to the
     * same set the redacting logger blocks; override to extend.
     */
    readonly phiKeys?: readonly string[];
    /**
     * Regex patterns for PHI-shaped values. Each pattern carries a label
     * that surfaces in the finding so test failures point at the rule.
     */
    readonly patterns?: readonly { readonly label: string; readonly pattern: RegExp }[];
    /**
     * String tokens (case-insensitive) that must never appear in a
     * trace body — typically the names + identifiers used in seed
     * fixtures so a regression that uploads a real prompt is caught.
     */
    readonly canaries?: readonly string[];
}

const DEFAULT_PHI_KEYS: readonly string[] = [
    'firstName',
    'lastName',
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
    'notes',
];

const DEFAULT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
    { label: 'mrn-prefix', pattern: /\bMRN[-:]?\s*\d{3,}\b/i },
    { label: 'us-phone', pattern: /\b\d{3}[- .]?\d{3}[- .]?\d{4}\b/ },
];

const DEFAULT_CANARIES: readonly string[] = [];

const MAX_DEPTH = 50;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const childPath = (path: string, segment: string): string =>
    path.length === 0 ? segment : `${path}.${segment}`;

const indexPath = (path: string, index: number): string => `${path}[${index}]`;

export const scanForPhi = (
    root: unknown,
    options: PhiScanOptions = {},
): readonly PhiFinding[] => {
    const phiKeys = new Set((options.phiKeys ?? DEFAULT_PHI_KEYS).map((k) => k.toLowerCase()));
    const patterns = options.patterns ?? DEFAULT_PATTERNS;
    const canaries = options.canaries ?? DEFAULT_CANARIES;
    const lowerCanaries = canaries.map((c) => c.toLowerCase());
    const findings: PhiFinding[] = [];

    const visit = (node: unknown, path: string, depth: number): void => {
        if (depth > MAX_DEPTH) {
            return;
        }
        if (typeof node === 'string') {
            for (const { label, pattern } of patterns) {
                if (pattern.test(node)) {
                    findings.push({ path, kind: 'phi-pattern', match: label });
                }
            }
            const lower = node.toLowerCase();
            for (let i = 0; i < lowerCanaries.length; i += 1) {
                if (lower.includes(lowerCanaries[i]!)) {
                    findings.push({ path, kind: 'phi-canary', match: canaries[i]! });
                }
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item, idx) => {
                visit(item, indexPath(path, idx), depth + 1);
            });
            return;
        }
        if (isPlainObject(node)) {
            for (const [key, value] of Object.entries(node)) {
                if (phiKeys.has(key.toLowerCase())) {
                    findings.push({ path: childPath(path, key), kind: 'phi-key', match: key });
                }
                visit(value, childPath(path, key), depth + 1);
            }
        }
    };

    visit(root, '', 0);
    return findings;
};
