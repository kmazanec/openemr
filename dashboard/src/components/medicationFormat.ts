import type { MedicationRequest } from '@medplum/fhirtypes';

export function drugOf(m: MedicationRequest): string {
  const text = m.medicationCodeableConcept?.text;
  if (typeof text === 'string' && text.length > 0) return text;
  const display = m.medicationCodeableConcept?.coding?.find(
    (c) => typeof c.display === 'string',
  )?.display;
  return display ?? '—';
}

export function doseOf(m: MedicationRequest): string {
  return m.dosageInstruction?.[0]?.text ?? '—';
}

export function routeOf(m: MedicationRequest): string {
  const route = m.dosageInstruction?.[0]?.route;
  if (typeof route?.text === 'string' && route.text.length > 0) return route.text;
  const display = route?.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}

export function frequencyOf(m: MedicationRequest): string {
  const timing = m.dosageInstruction?.[0]?.timing;
  if (typeof timing?.code?.text === 'string' && timing.code.text.length > 0) return timing.code.text;
  const display = timing?.code?.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '—';
}
