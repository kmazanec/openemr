import { useState, type ReactElement } from 'react';
import type { Condition } from '@medplum/fhirtypes';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';

export interface ProblemEditModalProps {
  puuid: string;
  problem: Condition | null;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

const VERIFICATIONS = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'unconfirmed', label: 'Unconfirmed' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'differential', label: 'Differential' },
] as const;

const ICD10_SYS = 'http://hl7.org/fhir/sid/icd-10-cm';
const SNOMED_SYS = 'http://snomed.info/sct';

export function ProblemEditModal({
  puuid,
  problem,
  onClose,
  onSaved,
  fetchFn,
}: ProblemEditModalProps): ReactElement {
  const [title, setTitle] = useState<string>(initialTitle(problem));
  const [diagnosis, setDiagnosis] = useState<string>(initialDiagnosis(problem));
  const [begdate, setBegdate] = useState<string>(problem?.onsetDateTime?.slice(0, 10) ?? '');
  const [verification, setVerification] = useState<string>(
    problem?.verificationStatus?.coding?.[0]?.code ?? 'confirmed',
  );
  const [comments, setComments] = useState<string>(problem?.note?.[0]?.text ?? '');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isEdit = problem !== null && typeof problem.id === 'string' && problem.id.length > 0;

  const onSubmit = async (): Promise<void> => {
    if (title.trim() === '') {
      setErrorMessage('A problem title is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    const result = await callEditor(
      'save_problem',
      {
        puuid,
        uuid: isEdit ? problem?.id : null,
        title: title.trim(),
        diagnosis: diagnosis.trim() === '' ? null : diagnosis.trim(),
        begdate: begdate.trim() === '' ? null : begdate.trim(),
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
      title={isEdit ? 'Edit medical problem' : 'Add medical problem'}
      saveLabel={isEdit ? 'Save changes' : 'Add problem'}
      saving={saving}
      saveDisabled={title.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="problem-edit-modal"
    >
      <div className="mb-3">
        <label htmlFor="problem-title" className="form-label small fw-semibold">
          Problem
        </label>
        <input
          id="problem-title"
          type="text"
          className="form-control form-control-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={160}
          data-testid="problem-title-input"
          autoFocus
        />
      </div>
      <div className="row g-2">
        <div className="col-7">
          <label htmlFor="problem-diagnosis" className="form-label small fw-semibold">
            Code (ICD-10 / SNOMED)
          </label>
          <input
            id="problem-diagnosis"
            type="text"
            className="form-control form-control-sm"
            value={diagnosis}
            onChange={(e) => setDiagnosis(e.target.value)}
            placeholder="e.g. ICD10:E11.9"
            data-testid="problem-diagnosis-input"
          />
        </div>
        <div className="col-5">
          <label htmlFor="problem-begdate" className="form-label small fw-semibold">
            Onset
          </label>
          <input
            id="problem-begdate"
            type="date"
            className="form-control form-control-sm"
            value={begdate}
            onChange={(e) => setBegdate(e.target.value)}
            data-testid="problem-begdate-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="problem-verification" className="form-label small fw-semibold">
          Verification
        </label>
        <select
          id="problem-verification"
          className="form-select form-select-sm"
          value={verification}
          onChange={(e) => setVerification(e.target.value)}
          data-testid="problem-verification-select"
        >
          {VERIFICATIONS.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3">
        <label htmlFor="problem-comments" className="form-label small fw-semibold">
          Comments
        </label>
        <textarea
          id="problem-comments"
          className="form-control form-control-sm"
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          data-testid="problem-comments-input"
        />
      </div>
    </EditModal>
  );
}

function initialTitle(c: Condition | null): string {
  if (c === null) return '';
  const codings = c.code?.coding ?? [];
  const snomed = codings.find((cc) => cc.system === SNOMED_SYS && typeof cc.display === 'string');
  if (snomed?.display !== undefined) return snomed.display;
  const icd = codings.find((cc) => cc.system === ICD10_SYS && typeof cc.display === 'string');
  if (icd?.display !== undefined) return icd.display;
  if (typeof c.code?.text === 'string') return c.code.text;
  return '';
}

function initialDiagnosis(c: Condition | null): string {
  if (c === null) return '';
  const codings = c.code?.coding ?? [];
  const icd = codings.find((cc) => cc.system === ICD10_SYS && typeof cc.code === 'string');
  if (icd?.code !== undefined) return `ICD10:${icd.code}`;
  const snomed = codings.find((cc) => cc.system === SNOMED_SYS && typeof cc.code === 'string');
  if (snomed?.code !== undefined) return `SNOMED-CT:${snomed.code}`;
  return '';
}
