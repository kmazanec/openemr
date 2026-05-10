import { useState, type ReactElement } from 'react';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';

/**
 * Manual lab-result entry modal — for the "doctor wants to chart a
 * result the patient brought in on paper" workflow. Posts to
 * `save_lab_result`, which writes a `procedure_result` row keyed by
 * the report id the doctor selects (or 0 for an ad-hoc entry).
 *
 * Editing existing lab results requires touching procedure_order /
 * procedure_report joins that the dashboard isn't fetching today —
 * out of scope for this pass. The card surfaces the "Add result"
 * affordance only.
 */
export interface LabResultEditModalProps {
  puuid: string;
  reportId?: number;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

const ABNORMAL_FLAGS = [
  { value: 'no', label: 'Normal' },
  { value: 'yes', label: 'Abnormal' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'critical', label: 'Critical' },
] as const;

export function LabResultEditModal({
  puuid,
  reportId,
  onClose,
  onSaved,
  fetchFn,
}: LabResultEditModalProps): ReactElement {
  const [resultCode, setResultCode] = useState<string>('');
  const [resultText, setResultText] = useState<string>('');
  const [resultValue, setResultValue] = useState<string>('');
  const [units, setUnits] = useState<string>('');
  const [range, setRange] = useState<string>('');
  const [abnormal, setAbnormal] = useState<string>('no');
  const [date, setDate] = useState<string>(today());
  const [comments, setComments] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    if (resultCode.trim() === '') {
      setErrorMessage('A test code (e.g. LOINC) or label is required.');
      return;
    }
    if (resultValue.trim() === '') {
      setErrorMessage('A result value is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    const result = await callEditor(
      'save_lab_result',
      {
        puuid,
        report_id: reportId ?? 0,
        result_code: resultCode.trim(),
        result_text: resultText.trim(),
        result: resultValue.trim(),
        units: units.trim(),
        range: range.trim(),
        abnormal,
        date: `${date} 00:00:00`,
        comments: comments.trim(),
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
      title="Add lab result"
      saveLabel="Add result"
      saving={saving}
      saveDisabled={resultCode.trim() === '' || resultValue.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="lab-result-edit-modal"
    >
      <div className="row g-2">
        <div className="col-5">
          <label htmlFor="lab-code" className="form-label small fw-semibold">
            Test code (LOINC)
          </label>
          <input
            id="lab-code"
            type="text"
            className="form-control form-control-sm"
            value={resultCode}
            onChange={(e) => setResultCode(e.target.value)}
            placeholder="e.g. 4548-4"
            required
            data-testid="lab-code-input"
            autoFocus
          />
        </div>
        <div className="col-7">
          <label htmlFor="lab-label" className="form-label small fw-semibold">
            Test label
          </label>
          <input
            id="lab-label"
            type="text"
            className="form-control form-control-sm"
            value={resultText}
            onChange={(e) => setResultText(e.target.value)}
            placeholder="Hemoglobin A1c"
            data-testid="lab-label-input"
          />
        </div>
      </div>
      <div className="row g-2 mt-1">
        <div className="col-4">
          <label htmlFor="lab-value" className="form-label small fw-semibold">
            Result
          </label>
          <input
            id="lab-value"
            type="text"
            className="form-control form-control-sm"
            value={resultValue}
            onChange={(e) => setResultValue(e.target.value)}
            placeholder="6.8"
            required
            data-testid="lab-value-input"
          />
        </div>
        <div className="col-3">
          <label htmlFor="lab-units" className="form-label small fw-semibold">
            Units
          </label>
          <input
            id="lab-units"
            type="text"
            className="form-control form-control-sm"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            placeholder="%"
            data-testid="lab-units-input"
          />
        </div>
        <div className="col-5">
          <label htmlFor="lab-range" className="form-label small fw-semibold">
            Reference range
          </label>
          <input
            id="lab-range"
            type="text"
            className="form-control form-control-sm"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            placeholder="<5.7"
            data-testid="lab-range-input"
          />
        </div>
      </div>
      <div className="row g-2 mt-1">
        <div className="col-6">
          <label htmlFor="lab-abnormal" className="form-label small fw-semibold">
            Flag
          </label>
          <select
            id="lab-abnormal"
            className="form-select form-select-sm"
            value={abnormal}
            onChange={(e) => setAbnormal(e.target.value)}
            data-testid="lab-abnormal-select"
          >
            {ABNORMAL_FLAGS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-6">
          <label htmlFor="lab-date" className="form-label small fw-semibold">
            Date
          </label>
          <input
            id="lab-date"
            type="date"
            className="form-control form-control-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="lab-date-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="lab-comments" className="form-label small fw-semibold">
          Comments
        </label>
        <textarea
          id="lab-comments"
          className="form-control form-control-sm"
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          data-testid="lab-comments-input"
        />
      </div>
    </EditModal>
  );
}

function today(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
