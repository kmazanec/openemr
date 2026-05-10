import { useState, type ReactElement } from 'react';
import type { AllergyIntolerance } from '@medplum/fhirtypes';
import { EditModal } from './EditModal';
import {
  callEditor,
  messageForEditorError,
  type EditorResult,
} from '../lib/dashboardEditor';

/**
 * In-page edit modal for an allergy row, plus the "add allergy" path
 * (passed `allergy={null}`). On save it POSTs to the dashboard-editor
 * module's `save_allergy` action, which wraps OpenEMR's
 * `AllergyIntoleranceService::insert/update` so the FHIR layer's
 * GET re-fetch after `onSaved()` returns the latest row.
 */
export interface AllergyEditModalProps {
  puuid: string;
  allergy: AllergyIntolerance | null;
  onClose: () => void;
  onSaved: () => void;
  // Test-only override.
  fetchFn?: typeof fetch;
}

const SEVERITIES = [
  { value: '', label: '— Severity —' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

const VERIFICATIONS = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'unconfirmed', label: 'Unconfirmed' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'entered-in-error', label: 'Entered in error' },
] as const;

export function AllergyEditModal({
  puuid,
  allergy,
  onClose,
  onSaved,
  fetchFn,
}: AllergyEditModalProps): ReactElement {
  const [title, setTitle] = useState<string>(initialTitle(allergy));
  const [severity, setSeverity] = useState<string>(allergy?.criticality ?? '');
  const [reaction, setReaction] = useState<string>(initialReaction(allergy));
  const [verification, setVerification] = useState<string>(
    allergy?.verificationStatus?.coding?.[0]?.code ?? 'confirmed',
  );
  const [comments, setComments] = useState<string>(initialComments(allergy));
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isEdit = allergy !== null && typeof allergy.id === 'string' && allergy.id.length > 0;
  const onSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setErrorMessage('An allergen name is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    const result: EditorResult = await callEditor(
      'save_allergy',
      {
        puuid,
        uuid: isEdit ? allergy?.id : null,
        title: title.trim(),
        severity: severity === '' ? null : severity,
        reaction: reaction.trim() === '' ? null : reaction.trim(),
        verification,
        comments: comments.trim() === '' ? null : comments.trim(),
      },
      fetchFn !== undefined ? { fetchFn } : {},
    );
    setSaving(false);
    if (result.ok) {
      onSaved();
      return;
    }
    setErrorMessage(messageForEditorError(result));
  };

  return (
    <EditModal
      open
      title={isEdit ? 'Edit allergy' : 'Add allergy'}
      saveLabel={isEdit ? 'Save changes' : 'Add allergy'}
      saving={saving}
      saveDisabled={title.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="allergy-edit-modal"
    >
      <div className="mb-3">
        <label htmlFor="allergy-title" className="form-label small fw-semibold">
          Allergen
        </label>
        <input
          id="allergy-title"
          type="text"
          className="form-control form-control-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={120}
          data-testid="allergy-title-input"
          autoFocus
        />
      </div>
      <div className="row g-2">
        <div className="col-6">
          <label htmlFor="allergy-severity" className="form-label small fw-semibold">
            Severity
          </label>
          <select
            id="allergy-severity"
            className="form-select form-select-sm"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            data-testid="allergy-severity-select"
          >
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-6">
          <label htmlFor="allergy-verification" className="form-label small fw-semibold">
            Status
          </label>
          <select
            id="allergy-verification"
            className="form-select form-select-sm"
            value={verification}
            onChange={(e) => setVerification(e.target.value)}
            data-testid="allergy-verification-select"
          >
            {VERIFICATIONS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="allergy-reaction" className="form-label small fw-semibold">
          Reaction
        </label>
        <input
          id="allergy-reaction"
          type="text"
          className="form-control form-control-sm"
          value={reaction}
          onChange={(e) => setReaction(e.target.value)}
          placeholder="e.g. hives, anaphylaxis"
          data-testid="allergy-reaction-input"
        />
      </div>
      <div className="mt-3">
        <label htmlFor="allergy-comments" className="form-label small fw-semibold">
          Comments
        </label>
        <textarea
          id="allergy-comments"
          className="form-control form-control-sm"
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          data-testid="allergy-comments-input"
        />
      </div>
    </EditModal>
  );
}

function initialTitle(a: AllergyIntolerance | null): string {
  if (a === null) return '';
  if (typeof a.code?.text === 'string') return a.code.text;
  const display = a.code?.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '';
}

function initialReaction(a: AllergyIntolerance | null): string {
  if (a === null) return '';
  const m = a.reaction?.[0]?.manifestation?.[0];
  if (m === undefined) return '';
  if (typeof m.text === 'string') return m.text;
  const display = m.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? '';
}

function initialComments(a: AllergyIntolerance | null): string {
  if (a === null) return '';
  const note = a.note?.[0]?.text;
  return typeof note === 'string' ? note : '';
}
