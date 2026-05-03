import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BriefingSnapshot } from '../../src/graph/types.js';
import type { ChartSnapshot } from '../../src/snapshot/types.js';

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc1');

/**
 * Load a UC1 fixture and adapt it to the in-graph `BriefingSnapshot`
 * shape. UC1 fixtures are pinned `ChartSnapshot` JSON; the only
 * difference between the two shapes is `labHistory`, which UC1 turns
 * never populate (UC2 has its own fixture loader).
 *
 * Per user direction, §4.3 keeps UC3 fixtures colocated under `uc1/`
 * rather than splitting into a `uc3/` sibling — loader accepts any
 * string key (UC1's ArchetypeKey or one of the §4.3 named fixtures
 * like `lisinopril_recent_start`); the file must exist under
 * `evals/fixtures/uc1/`.
 */
export const loadFixture = (archetype: string): BriefingSnapshot => {
    const path = resolve(FIXTURES_DIR, `${archetype}.json`);
    const chart = JSON.parse(readFileSync(path, 'utf8')) as ChartSnapshot;
    return {
        ...chart,
        labHistory: null,
    };
};

const UC2_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc2');

export type Uc2Scenario = 'a1c_trend_up' | 'a1c_trend_stable' | 'no_lab_history';

/**
 * Load a §4.2 UC2 fixture. Returns a `BriefingSnapshot` whose
 * `labHistory` slot is populated — that's the whole point of UC2.
 * Unlike `loadFixture`, no adaptation is needed: the regenerator
 * emits BriefingSnapshot directly.
 */
export const loadUc2Fixture = (scenario: Uc2Scenario): BriefingSnapshot => {
    const path = resolve(UC2_FIXTURES_DIR, `${scenario}.json`);
    return JSON.parse(readFileSync(path, 'utf8')) as BriefingSnapshot;
};

const UC5_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'uc5');

export interface Uc5LoadedSlot {
    readonly appointmentId: string;
    readonly practitionerUuid: string;
    readonly startAt: string;
    readonly archetype: string;
    readonly snapshot: BriefingSnapshot;
    readonly expectedArchetypeFlags: readonly string[];
}

export interface Uc5LoadedDay {
    readonly practitionerUuid: string;
    readonly day: string;
    readonly slots: readonly Uc5LoadedSlot[];
}

/**
 * Load the §5.5 morning-prep day fixture. Adapts each slot's wire-shape
 * snapshot (number ids) into the in-graph `BriefingSnapshot` shape
 * (string ids + `labHistory: null`) so callers can drive the briefing
 * graph directly.
 */
export const loadUc5MorningPrepDay = (): Uc5LoadedDay => {
    const path = resolve(UC5_FIXTURES_DIR, 'morning_prep_day.json');
    interface RawSlot {
        readonly appointmentId: string;
        readonly practitionerUuid: string;
        readonly startAt: string;
        readonly archetype: string;
        readonly snapshot: Record<string, unknown>;
        readonly expectedArchetypeFlags: readonly string[];
    }
    interface RawDay {
        readonly practitionerUuid: string;
        readonly day: string;
        readonly slots: readonly RawSlot[];
    }
    // Narrow a wire-shape id (`number | null` on the JSON side, held
    // as `string | null` everywhere on the TS side) into the in-graph
    // representation without leaning on `String(unknown)` — that
    // route stringifies arbitrary objects to `[object Object]`,
    // which the eslint `no-base-to-string` rule (correctly) bans.
    const stringifyId = (raw: unknown): string | null => {
        if (raw === null || raw === undefined) {
            return null;
        }
        if (typeof raw === 'string') {
            return raw;
        }
        if (typeof raw === 'number' || typeof raw === 'bigint') {
            return raw.toString();
        }
        throw new TypeError(`unexpected wire-shape id (${typeof raw})`);
    };
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawDay;
    return {
        practitionerUuid: raw.practitionerUuid,
        day: raw.day,
        slots: raw.slots.map((slot): Uc5LoadedSlot => {
            const wire = slot.snapshot;
            const prescriptionsRaw = wire['prescriptions'];
            const prescriptions = Array.isArray(prescriptionsRaw)
                ? prescriptionsRaw.map((p: Record<string, unknown>) => ({
                    ...p,
                    prescriptionId: stringifyId(p['prescriptionId']),
                }))
                : prescriptionsRaw;
            const remindersRaw = wire['reminders'];
            const reminders = Array.isArray(remindersRaw)
                ? remindersRaw.map((r: Record<string, unknown>) => ({
                    ...r,
                    reminderId: stringifyId(r['reminderId']),
                }))
                : remindersRaw;
            const medsRaw = wire['medications'];
            const medications = Array.isArray(medsRaw)
                ? medsRaw.map((m: Record<string, unknown>) => ({
                    ...m,
                    listId: stringifyId(m['listId']),
                }))
                : medsRaw;
            const adapted = {
                ...wire,
                prescriptions,
                reminders,
                medications,
                labHistory: null,
            } as unknown as BriefingSnapshot;
            return {
                appointmentId: slot.appointmentId,
                practitionerUuid: slot.practitionerUuid,
                startAt: slot.startAt,
                archetype: slot.archetype,
                snapshot: adapted,
                expectedArchetypeFlags: slot.expectedArchetypeFlags,
            };
        }),
    };
};
