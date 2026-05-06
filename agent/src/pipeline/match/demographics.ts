/**
 * §B.6 demographics matchers.
 *
 * Pure structural matchers for the patient-match node. Both functions
 * return one of {1.0, 0.6, 0.5, 0.0} so the caller can route confident-
 * match / partial-match / refuse without inventing scores at the
 * decision site.
 *
 * Per `W2_ARCHITECTURE.md` §"Patient match" — fuzzy / phonetic /
 * Levenshtein-shaped matching is a deliberate non-goal for the W2
 * sprint. Three-bucket structural disposition is sufficient for the
 * "wrong-patient document refuse" eval cases and keeps the decision
 * predictable for the verifier downstream.
 *
 * Both inputs are treated symmetrically: the matcher does not know
 * which side is the chart and which is the extracted document, so
 * `matchName(a, b) === matchName(b, a)` is part of the contract.
 */

export type MatchScore = 0.0 | 0.5 | 0.6 | 1.0;

const collapseWhitespace = (s: string): string => s.trim().replace(/\s+/g, ' ');

/**
 * Tokenise a personal name into `{first, surname}` after handling the
 * inverted "Surname, Given" form some intake forms use.
 *
 *   - "Chen, Margaret L."   → { first: 'margaret', surname: 'chen' }
 *   - "Margaret L. Chen"    → { first: 'margaret', surname: 'chen' }
 *   - "Chen"                → { first: null,       surname: 'chen' }
 *   - ""                    → null (caller should treat as no-match)
 */
const tokeniseName = (raw: string): { first: string | null; surname: string } | null => {
    const cleaned = collapseWhitespace(raw).toLowerCase();
    if (cleaned.length === 0) return null;

    // Inverted form: "Surname, Given Middle..."
    const commaIdx = cleaned.indexOf(',');
    if (commaIdx >= 0) {
        const surname = cleaned.slice(0, commaIdx).trim();
        const rest = cleaned.slice(commaIdx + 1).trim();
        if (surname.length === 0) return null;
        const givenTokens = rest.split(/\s+/).filter((t) => t.length > 0);
        const first = givenTokens.length > 0 ? givenTokens[0]! : null;
        return { first, surname };
    }

    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) {
        return { first: null, surname: tokens[0]! };
    }
    return { first: tokens[0]!, surname: tokens[tokens.length - 1]! };
};

/**
 * Strip a trailing period (treat "M." and "M" as the same initial) and
 * return the first character, or null if the token is empty.
 */
const initialOf = (token: string | null): string | null => {
    if (token === null) return null;
    const stripped = token.replace(/\.$/, '');
    return stripped.length > 0 ? stripped[0]! : null;
};

/**
 * Structural name match per §B.6.
 *
 *   - Exact match (case- and whitespace-insensitive, comma-form
 *     equivalent to space-form) → 1.0.
 *   - Same surname AND same first-name initial → 0.6.
 *   - Same surname, single-token on either side (no first-initial axis
 *     to compare) → 0.6 — matches the way the eval suite scans last
 *     names off lab headers without given names.
 *   - Otherwise → 0.0.
 */
export const matchName = (a: string, b: string): MatchScore => {
    const left = tokeniseName(a);
    const right = tokeniseName(b);
    if (left === null || right === null) return 0.0;

    if (left.surname !== right.surname) return 0.0;

    const leftInitial = initialOf(left.first);
    const rightInitial = initialOf(right.first);

    // Both fully named: exact match if first-name tokens match outright.
    if (leftInitial !== null && rightInitial !== null) {
        if (left.first === right.first) return 1.0;
        return leftInitial === rightInitial ? 0.6 : 0.0;
    }

    // At least one side is single-token (just a surname). Treat as a
    // partial: same surname, no contradiction on the first-initial axis.
    return 0.6;
};

/**
 * Parse a date string into a `Date` at UTC midnight.
 *
 * Accepts:
 *   - ISO `YYYY-MM-DD` (the schema's normalised form).
 *   - `MM/DD/YYYY` (the literal `quote` form vision sometimes returns
 *     even when the structured `value` is supposed to be ISO — refusing
 *     on a format mismatch would be a false negative).
 *
 * Returns null on any other input. Validates calendar legality (e.g.,
 * rejects `1967-02-30`).
 */
const parseDob = (raw: string): Date | null => {
    const trimmed = raw.trim();

    let y: number, m: number, d: number;
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (isoMatch !== null) {
        y = Number(isoMatch[1]);
        m = Number(isoMatch[2]);
        d = Number(isoMatch[3]);
    } else {
        const usMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
        if (usMatch === null) return null;
        m = Number(usMatch[1]);
        d = Number(usMatch[2]);
        y = Number(usMatch[3]);
    }

    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;

    const candidate = new Date(Date.UTC(y, m - 1, d));
    if (
        candidate.getUTCFullYear() !== y ||
        candidate.getUTCMonth() !== m - 1 ||
        candidate.getUTCDate() !== d
    ) {
        return null;
    }
    return candidate;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Structural DOB match per §B.6.
 *
 *   - Exact same calendar date → 1.0.
 *   - Off by exactly one day in either direction → 0.5 (typo-shaped:
 *     transposed digit, off-by-one transcription).
 *   - Otherwise → 0.0.
 *   - Invalid / null inputs → 0.0 (the matcher never crashes on bad
 *     input — the caller takes a 0.0 as "not extractable" and the
 *     downstream disposition handles refuse vs. partial).
 */
export const matchDob = (a: string | null, b: string | null): MatchScore => {
    if (a === null || b === null) return 0.0;
    const left = parseDob(a);
    const right = parseDob(b);
    if (left === null || right === null) return 0.0;

    const deltaMs = Math.abs(left.getTime() - right.getTime());
    if (deltaMs === 0) return 1.0;
    if (deltaMs === ONE_DAY_MS) return 0.5;
    return 0.0;
};
