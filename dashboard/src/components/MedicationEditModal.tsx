import { useState, type ReactElement } from 'react';
import type { MedicationRequest } from '@medplum/fhirtypes';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';
import { drugOf } from './medicationFormat';

/**
 * In-page edit modal for the patient's currently-taking medication
 * list — the same set the legacy "Medications" stats panel manages.
 * On save, posts to `save_medication` which writes the lists row +
 * lists_medication join the FHIR layer reads from.
 */
export interface MedicationEditModalProps {
  puuid: string;
  medication: MedicationRequest | null;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

export function MedicationEditModal({
  puuid,
  medication,
  onClose,
  onSaved,
  fetchFn,
}: MedicationEditModalProps): ReactElement {
  const [title, setTitle] = useState<string>(initialTitle(medication));
  const [dose, setDose] = useState<string>(medication?.dosageInstruction?.[0]?.text ?? '');
  const [begdate, setBegdate] = useState<string>(initialBegdate(medication));
  const [comments, setComments] = useState<string>(medication?.note?.[0]?.text ?? '');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isEdit = medication !== null && typeof medication.id === 'string' && medication.id.length > 0;

  const onSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setErrorMessage('A drug name is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    // We bundle the drug name + the dosage instruction into the
    // lists.title and lists.comments fields respectively; the legacy
    // stats panel uses the same convention so the existing FHIR
    // serializer keeps producing usable medication names.
    const fullTitle = dose.trim().length > 0 ? `${title.trim()} ${dose.trim()}` : title.trim();
    const result = await callEditor(
      'save_medication',
      {
        puuid,
        uuid: isEdit ? medication?.id ?? null : null,
        title: fullTitle,
        begdate: begdate.trim() === '' ? null : begdate.trim(),
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
      title={isEdit ? 'Edit medication' : 'Add medication'}
      saveLabel={isEdit ? 'Save changes' : 'Add medication'}
      saving={saving}
      saveDisabled={title.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="medication-edit-modal"
    >
      <div className="mb-3">
        <label htmlFor="medication-title" className="form-label small fw-semibold">
          Drug
        </label>
        <input
          id="medication-title"
          type="text"
          className="form-control form-control-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={160}
          placeholder="e.g. Lisinopril"
          data-testid="medication-title-input"
          autoFocus
        />
      </div>
      <div className="row g-2">
        <div className="col-7">
          <label htmlFor="medication-dose" className="form-label small fw-semibold">
            Dose / instructions
          </label>
          <input
            id="medication-dose"
            type="text"
            className="form-control form-control-sm"
            value={dose}
            onChange={(e) => setDose(e.target.value)}
            placeholder="e.g. 10 mg PO daily"
            data-testid="medication-dose-input"
          />
        </div>
        <div className="col-5">
          <label htmlFor="medication-begdate" className="form-label small fw-semibold">
            Started
          </label>
          <input
            id="medication-begdate"
            type="date"
            className="form-control form-control-sm"
            value={begdate}
            onChange={(e) => setBegdate(e.target.value)}
            data-testid="medication-begdate-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="medication-comments" className="form-label small fw-semibold">
          Comments
        </label>
        <textarea
          id="medication-comments"
          className="form-control form-control-sm"
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          data-testid="medication-comments-input"
        />
      </div>
    </EditModal>
  );
}

function initialTitle(m: MedicationRequest | null): string {
  if (m === null) return '';
  return drugOf(m).replace(/—/g, '');
}

function initialBegdate(m: MedicationRequest | null): string {
  const a = m?.authoredOn;
  if (typeof a !== 'string' || a.length === 0) return '';
  return a.slice(0, 10);
}
