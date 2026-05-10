import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AllergyIntolerance } from '@medplum/fhirtypes';
import { AllergyEditModal } from './AllergyEditModal';

const csrfBefore = (window as unknown as { csrf_token_js?: unknown }).csrf_token_js;
beforeAll(() => {
  (window as unknown as { csrf_token_js?: unknown }).csrf_token_js = 'csrf-test';
});
afterAll(() => {
  (window as unknown as { csrf_token_js?: unknown }).csrf_token_js = csrfBefore;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AllergyEditModal', () => {
  it('renders an empty form when adding (allergy=null)', () => {
    render(
      <AllergyEditModal
        puuid="puuid-1"
        allergy={null}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    expect(screen.getByTestId('allergy-edit-modal-title')).toHaveTextContent('Add allergy');
    expect(screen.getByTestId<HTMLInputElement>('allergy-title-input').value).toBe('');
    // Save is disabled until the doctor types an allergen.
    expect(screen.getByTestId('allergy-edit-modal-save')).toBeDisabled();
  });

  it('pre-fills the form when editing an existing allergy', () => {
    const allergy: AllergyIntolerance = {
      resourceType: 'AllergyIntolerance',
      id: 'a1',
      code: { text: 'Penicillin' },
      criticality: 'high',
      reaction: [{ manifestation: [{ text: 'Hives' }] }],
      patient: { reference: 'Patient/x' },
    };
    render(
      <AllergyEditModal
        puuid="puuid-1"
        allergy={allergy}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    expect(screen.getByTestId('allergy-edit-modal-title')).toHaveTextContent('Edit allergy');
    expect(screen.getByTestId<HTMLInputElement>('allergy-title-input').value).toBe(
      'Penicillin',
    );
    expect(screen.getByTestId<HTMLSelectElement>('allergy-severity-select').value).toBe('high');
    expect(screen.getByTestId<HTMLInputElement>('allergy-reaction-input').value).toBe('Hives');
  });

  it('POSTs save_allergy on submit and calls onSaved on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: {} }));
    const onSaved = vi.fn();
    render(
      <AllergyEditModal
        puuid="puuid-1"
        allergy={null}
        onClose={() => undefined}
        onSaved={onSaved}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.change(screen.getByTestId('allergy-title-input'), {
      target: { value: 'Sulfa drugs' },
    });
    fireEvent.change(screen.getByTestId('allergy-severity-select'), {
      target: { value: 'medium' },
    });
    fireEvent.click(screen.getByTestId('allergy-edit-modal-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body.action).toBe('save_allergy');
    expect(body.title).toBe('Sulfa drugs');
    expect(body.severity).toBe('medium');
    expect(body.uuid).toBeNull();
  });

  it('renders the editor error message when save fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'validation_failed' }, 400));
    render(
      <AllergyEditModal
        puuid="puuid-1"
        allergy={null}
        onClose={() => undefined}
        onSaved={() => undefined}
        fetchFn={fetchMock as unknown as typeof fetch}
      />,
    );
    fireEvent.change(screen.getByTestId('allergy-title-input'), {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTestId('allergy-edit-modal-save'));

    await waitFor(() =>
      expect(screen.getByTestId('allergy-edit-modal-error')).toHaveTextContent(
        /correct the highlighted/i,
      ),
    );
    // Buttons are re-enabled so the doctor can retry.
    expect(screen.getByTestId('allergy-edit-modal-save')).not.toBeDisabled();
  });
});
