/**
 * §5.5 UC5 morning-prep day fixture regenerator.
 *
 * Emits a single JSON file under `agent/evals/fixtures/morning-prep/` that
 * encodes a synthetic 20-patient day for one practitioner. Each slot
 * carries:
 *
 *   - `appointmentId`, `practitionerUuid`, and `startAt` per slot
 *     (distinct, deterministic)
 *   - `archetype` — the UC1 archetype the slot's `BriefingSnapshot`
 *     is adapted from
 *   - `snapshot` — a full `BriefingSnapshot`, derived by loading the
 *     UC1 archetype fixture and overlaying slot-specific metadata
 *   - `expectedArchetypeFlags` — what
 *     `deriveArchetypeFlags(snapshot)` should return for this slot
 *
 * `complex_elderly` slots get a synthetic recent prescription
 * overlaid so the §5.5 `archetype:complex_elderly_new_med` rule
 * fires; the canonical UC1 fixture's prescriptions are too old to
 * meet the 30-day lookback. The eval-level injection keeps the UC1
 * fixtures stable while letting UC5 surface the chip the
 * IMPLEMENTATION_PLAN promised.
 *
 * Output format mirrors `regenerate-uc2.ts`: 2-space indent + trailing
 * newline + ASCII-only so the repo's `pretty-format-json` pre-commit
 * hook does not rewrite the file on commit
 * (memory: feedback_json_fixtures_emit_hook_format.md).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveArchetypeFlags } from '../../src/graph/archetypeFlags.js';
import type { BriefingSnapshot } from '../../src/graph/types.js';
import type { Prescription, SourceReference } from '../../src/snapshot/types.js';

import { loadFixture } from './load.js';
import type { ArchetypeKey } from './regenerate-archetypes.js';

const PRACTITIONER_UUID = '11111111-1111-1111-1111-111111111111';
const DAY = '2026-05-04';

/**
 * Archetype mix for the 20-patient day. Hits the §5.5 contract:
 * three flagged archetypes (`diabetic_uncontrolled`,
 * `complex_elderly`, `recent_ed_visit`) and three unflagged ones
 * (`healthy_adult`, `hypertensive`, `diabetic`). Distribution favors
 * the unflagged archetypes so the eval distinguishes "right subset
 * is flagged" from "everything is flagged."
 */
const SLOT_PLAN: readonly ArchetypeKey[] = [
    'healthy_adult',
    'healthy_adult',
    'healthy_adult',
    'healthy_adult',
    'hypertensive',
    'hypertensive',
    'hypertensive',
    'hypertensive',
    'diabetic',
    'diabetic',
    'diabetic',
    'diabetic',
    'diabetic_uncontrolled',
    'diabetic_uncontrolled',
    'diabetic_uncontrolled',
    'complex_elderly',
    'complex_elderly',
    'complex_elderly',
    'recent_ed_visit',
    'recent_ed_visit',
];

const FIRST_SLOT_HOUR = 8;

const sourceRef = (
    recordType: string,
    recordId: string,
): SourceReference => ({
    system: 'openemr',
    recordType,
    recordId,
    field: null,
    recordedAt: null,
});

/**
 * Inject a synthetic prescription that started 14 days before the
 * appointment. Only used for `complex_elderly` slots so the §5.5
 * `archetype:complex_elderly_new_med` rule fires; UC1's canonical
 * fixture has prescriptions starting in 2008/2010 (decades old).
 */
const injectRecentPrescription = (
    snapshot: BriefingSnapshot,
    appointmentStartAt: string,
    slotIndex: number,
): BriefingSnapshot => {
    const apptMs = Date.parse(appointmentStartAt);
    const startedMs = apptMs - 14 * 24 * 60 * 60 * 1000;
    const startDate = new Date(startedMs).toISOString().slice(0, 10);
    const id = `rx-uc5-new-${String(slotIndex)}`;
    const newRx: Prescription = {
        name: 'Sertraline',
        dose: '50mg',
        route: 'oral',
        frequency: 'qd',
        startDate,
        stopDate: null,
        prescriber: 'Dr. Patel',
        indication: 'New start',
        prescriptionId: id,
        source: sourceRef('Prescription', id),
    };
    return {
        ...snapshot,
        prescriptions: [...snapshot.prescriptions, newRx],
    };
};

const slotStartAt = (slotIndex: number): string => {
    // 20 slots starting at 08:00 local, 30 minutes apart. Day is
    // 2026-05-04 (a Monday). Encoded in UTC for the wire shape; the
    // schedule view's local-tz formatting is the schedule view's
    // problem, not the eval's.
    const minutesFromStart = slotIndex * 30;
    const hour = FIRST_SLOT_HOUR + Math.floor(minutesFromStart / 60);
    const minute = minutesFromStart % 60;
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${DAY}T${hh}:${mm}:00Z`;
};

const slotAppointmentId = (slotIndex: number): string =>
    `apt-uc5-${String(slotIndex).padStart(2, '0')}`;

interface Uc5Slot {
    readonly appointmentId: string;
    readonly practitionerUuid: string;
    readonly startAt: string;
    readonly archetype: ArchetypeKey;
    readonly snapshot: BriefingSnapshot;
    readonly expectedArchetypeFlags: readonly string[];
}

export interface Uc5MorningPrepDay {
    readonly practitionerUuid: string;
    readonly day: string;
    readonly slots: readonly Uc5Slot[];
}

const buildSlot = (slotIndex: number, archetype: ArchetypeKey): Uc5Slot => {
    const appointmentId = slotAppointmentId(slotIndex);
    const startAt = slotStartAt(slotIndex);
    const baseSnapshot = loadFixture(archetype);
    const overlaidAppointment = {
        appointmentId,
        startAt,
        durationMinutes: 30,
        type: baseSnapshot.appointment?.type ?? 'Office visit',
        reason: baseSnapshot.appointment?.reason ?? null,
        source: sourceRef('Appointment', appointmentId),
    };
    let snapshot: BriefingSnapshot = {
        ...baseSnapshot,
        appointment: overlaidAppointment,
    };
    if (archetype === 'complex_elderly') {
        snapshot = injectRecentPrescription(snapshot, startAt, slotIndex);
    }
    const expectedArchetypeFlags = deriveArchetypeFlags(snapshot);
    return {
        appointmentId,
        practitionerUuid: PRACTITIONER_UUID,
        startAt,
        archetype,
        snapshot,
        expectedArchetypeFlags,
    };
};

const buildDay = (): Uc5MorningPrepDay => ({
    practitionerUuid: PRACTITIONER_UUID,
    day: DAY,
    slots: SLOT_PLAN.map((archetype, idx) => buildSlot(idx, archetype)),
});

/**
 * Coerce id fields from string (decoder shape) to JSON number (wire
 * shape). Mirrors the same coercion in `regenerate-uc2.ts::toWireFormat`.
 */
const toWireFormat = (snapshot: BriefingSnapshot): unknown => {
    const prescriptions = snapshot.prescriptions.map((p) => ({
        ...p,
        prescriptionId: p.prescriptionId === null ? null : Number.parseInt(p.prescriptionId, 10),
    }));
    const remindersIn = snapshot.reminders;
    const reminders = 'kind' in remindersIn
        ? remindersIn
        : remindersIn.map((r) => ({
            ...r,
            reminderId: r.reminderId === null ? null : Number.parseInt(r.reminderId, 10),
        }));
    const medsIn = snapshot.medications;
    const medications = 'kind' in medsIn
        ? medsIn
        : medsIn.map((m) => ({
            ...m,
            listId: m.listId === null ? null : Number.parseInt(m.listId, 10),
        }));
    return { ...snapshot, prescriptions, reminders, medications };
};

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'morning-prep');

export interface RegenerateMorningPrepResult {
    readonly path: string;
    readonly slotCount: number;
}

export const regenerate = (): RegenerateMorningPrepResult => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const day = buildDay();
    const wireSlots = day.slots.map((slot) => ({
        appointmentId: slot.appointmentId,
        practitionerUuid: slot.practitionerUuid,
        startAt: slot.startAt,
        archetype: slot.archetype,
        snapshot: toWireFormat(slot.snapshot),
        expectedArchetypeFlags: slot.expectedArchetypeFlags,
    }));
    const wireDay = {
        practitionerUuid: day.practitionerUuid,
        day: day.day,
        slots: wireSlots,
    };
    const path = resolve(FIXTURES_DIR, 'morning_prep_day.json');
    const body = `${JSON.stringify(wireDay, null, 2)}\n`;
    writeFileSync(path, body, { encoding: 'utf8' });
    return { path, slotCount: day.slots.length };
};

export const MORNING_PREP_SCENARIOS = ['morning_prep_day'] as const;

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const result = regenerate();
    process.stdout.write(`wrote ${String(result.slotCount)} slots → ${result.path}\n`);
}
