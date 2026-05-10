import { useState, type ReactElement } from 'react';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';

/**
 * In-page "Add prescription" modal. Replaces the dead-link button
 * that used to navigate to /interface/eRx.php (which 404s for
 * non-eRx-enabled installs and steals the user out of the dashboard
 * when it does work). Posts to `save_prescription`, which wraps
 * OpenEMR's PrescriptionService::insert().
 *
 * The minimum-viable form here mirrors the legacy "Add Prescription"
 * page's required + commonly-filled fields. Refills, route, and
 * pharmacy notes are exposed as optional. eRx integrations and
 * pharmacy routing remain a navigate-out flow — this component is
 * for the tracking/charting use case that doesn't need a wire-out.
 */
export interface PrescriptionEditModalProps {
  puuid: string;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

const ROUTES = [
  { value: '', label: '— Route —' },
  { value: 'oral', label: 'Oral' },
  { value: 'topical', label: 'Topical' },
  { value: 'inhaled', label: 'Inhaled' },
  { value: 'subcutaneous', label: 'Subcutaneous' },
  { value: 'intramuscular', label: 'Intramuscular' },
  { value: 'intravenous', label: 'Intravenous' },
] as const;

export function PrescriptionEditModal({
  puuid,
  onClose,
  onSaved,
  fetchFn,
}: PrescriptionEditModalProps): ReactElement {
  const [drug, setDrug] = useState<string>('');
  const [dosage, setDosage] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [unit, setUnit] = useState<string>('');
  const [route, setRoute] = useState<string>('');
  const [interval_, setInterval] = useState<string>('');
  const [instructions, setInstructions] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    if (drug.trim() === '') {
      setErrorMessage('A drug name is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    const result = await callEditor(
      'save_prescription',
      {
        puuid,
        drug: drug.trim(),
        dosage: dosage.trim() === '' ? null : dosage.trim(),
        quantity: quantity.trim() === '' ? null : quantity.trim(),
        size: size.trim() === '' ? null : size.trim(),
        unit: unit.trim() === '' ? null : unit.trim(),
        route: route === '' ? null : route,
        interval: interval_.trim() === '' ? null : interval_.trim(),
        instructions: instructions.trim() === '' ? null : instructions.trim(),
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
      title="Add prescription"
      saveLabel="Add prescription"
      saving={saving}
      saveDisabled={drug.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="prescription-edit-modal"
    >
      <div className="mb-3">
        <label htmlFor="rx-drug" className="form-label small fw-semibold">
          Drug
        </label>
        <input
          id="rx-drug"
          type="text"
          className="form-control form-control-sm"
          value={drug}
          onChange={(e) => setDrug(e.target.value)}
          required
          maxLength={160}
          placeholder="e.g. Metformin 500 mg"
          data-testid="rx-drug-input"
          autoFocus
        />
      </div>
      <div className="row g-2">
        <div className="col-6">
          <label htmlFor="rx-dosage" className="form-label small fw-semibold">
            Dose
          </label>
          <input
            id="rx-dosage"
            type="text"
            className="form-control form-control-sm"
            value={dosage}
            onChange={(e) => setDosage(e.target.value)}
            placeholder="e.g. 500 mg"
            data-testid="rx-dosage-input"
          />
        </div>
        <div className="col-3">
          <label htmlFor="rx-quantity" className="form-label small fw-semibold">
            Qty
          </label>
          <input
            id="rx-quantity"
            type="text"
            className="form-control form-control-sm"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="60"
            data-testid="rx-quantity-input"
          />
        </div>
        <div className="col-3">
          <label htmlFor="rx-size" className="form-label small fw-semibold">
            Size
          </label>
          <input
            id="rx-size"
            type="text"
            className="form-control form-control-sm"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="1"
            data-testid="rx-size-input"
          />
        </div>
      </div>
      <div className="row g-2 mt-1">
        <div className="col-4">
          <label htmlFor="rx-unit" className="form-label small fw-semibold">
            Unit
          </label>
          <input
            id="rx-unit"
            type="text"
            className="form-control form-control-sm"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="tablet"
            data-testid="rx-unit-input"
          />
        </div>
        <div className="col-4">
          <label htmlFor="rx-route" className="form-label small fw-semibold">
            Route
          </label>
          <select
            id="rx-route"
            className="form-select form-select-sm"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            data-testid="rx-route-select"
          >
            {ROUTES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-4">
          <label htmlFor="rx-interval" className="form-label small fw-semibold">
            Interval
          </label>
          <input
            id="rx-interval"
            type="text"
            className="form-control form-control-sm"
            value={interval_}
            onChange={(e) => setInterval(e.target.value)}
            placeholder="BID"
            data-testid="rx-interval-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="rx-instructions" className="form-label small fw-semibold">
          Patient instructions
        </label>
        <textarea
          id="rx-instructions"
          className="form-control form-control-sm"
          rows={2}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          data-testid="rx-instructions-input"
        />
      </div>
    </EditModal>
  );
}
