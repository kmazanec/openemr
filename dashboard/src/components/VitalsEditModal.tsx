import { useState, type ReactElement } from 'react';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';

/**
 * Add-vitals modal. Posts every filled-in vital as a single
 * `form_vitals` row through the dashboard-editor's `save_vitals`
 * action, which wraps OpenEMR's `VitalsService::save()`. The legacy
 * vitals form lets the doctor enter any subset of fields per visit;
 * we honor the same convention — empty fields are omitted from the
 * payload so the row doesn't store sentinel zeros.
 */
export interface VitalsEditModalProps {
  puuid: string;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

export function VitalsEditModal({
  puuid,
  onClose,
  onSaved,
  fetchFn,
}: VitalsEditModalProps): ReactElement {
  const [bps, setBps] = useState<string>('');
  const [bpd, setBpd] = useState<string>('');
  const [pulse, setPulse] = useState<string>('');
  const [respiration, setRespiration] = useState<string>('');
  const [temperature, setTemperature] = useState<string>('');
  const [tempMethod, setTempMethod] = useState<string>('');
  const [oxygenSat, setOxygenSat] = useState<string>('');
  const [weight, setWeight] = useState<string>('');
  const [height, setHeight] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    // VitalsService is happy with a sparse row, but require at least
    // one numeric vital so the doctor doesn't accidentally submit an
    // empty row from a stray click.
    if (
      [bps, bpd, pulse, respiration, temperature, oxygenSat, weight, height].every(
        (v) => v.trim() === '',
      )
    ) {
      setErrorMessage('Enter at least one vital before saving.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);
    const payload: Record<string, unknown> = { puuid };
    if (bps.trim() !== '') payload.bps = bps.trim();
    if (bpd.trim() !== '') payload.bpd = bpd.trim();
    if (pulse.trim() !== '') payload.pulse = pulse.trim();
    if (respiration.trim() !== '') payload.respiration = respiration.trim();
    if (temperature.trim() !== '') payload.temperature = temperature.trim();
    if (tempMethod !== '') payload.temp_method = tempMethod;
    if (oxygenSat.trim() !== '') payload.oxygen_saturation = oxygenSat.trim();
    if (weight.trim() !== '') payload.weight = weight.trim();
    if (height.trim() !== '') payload.height = height.trim();
    if (note.trim() !== '') payload.note = note.trim();

    const result = await callEditor(
      'save_vitals',
      payload,
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
      title="Add vitals"
      saveLabel="Add vitals"
      saving={saving}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="vitals-edit-modal"
    >
      <div className="row g-2">
        <div className="col-6">
          <label htmlFor="vit-bp" className="form-label small fw-semibold">
            Blood pressure (mmHg)
          </label>
          <div className="d-flex gap-1 align-items-center">
            <input
              id="vit-bp"
              type="number"
              inputMode="numeric"
              className="form-control form-control-sm"
              placeholder="120"
              value={bps}
              onChange={(e) => setBps(e.target.value)}
              data-testid="vitals-bps-input"
              aria-label="Systolic blood pressure"
            />
            <span aria-hidden="true">/</span>
            <input
              type="number"
              inputMode="numeric"
              className="form-control form-control-sm"
              placeholder="80"
              value={bpd}
              onChange={(e) => setBpd(e.target.value)}
              data-testid="vitals-bpd-input"
              aria-label="Diastolic blood pressure"
            />
          </div>
        </div>
        <div className="col-3">
          <label htmlFor="vit-hr" className="form-label small fw-semibold">
            Pulse
          </label>
          <input
            id="vit-hr"
            type="number"
            inputMode="numeric"
            className="form-control form-control-sm"
            placeholder="bpm"
            value={pulse}
            onChange={(e) => setPulse(e.target.value)}
            data-testid="vitals-pulse-input"
          />
        </div>
        <div className="col-3">
          <label htmlFor="vit-rr" className="form-label small fw-semibold">
            Resp
          </label>
          <input
            id="vit-rr"
            type="number"
            inputMode="numeric"
            className="form-control form-control-sm"
            placeholder="breaths/min"
            value={respiration}
            onChange={(e) => setRespiration(e.target.value)}
            data-testid="vitals-rr-input"
          />
        </div>
      </div>
      <div className="row g-2 mt-1">
        <div className="col-4">
          <label htmlFor="vit-temp" className="form-label small fw-semibold">
            Temperature
          </label>
          <input
            id="vit-temp"
            type="number"
            inputMode="decimal"
            step="0.1"
            className="form-control form-control-sm"
            placeholder="98.6"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            data-testid="vitals-temp-input"
          />
        </div>
        <div className="col-4">
          <label htmlFor="vit-temp-method" className="form-label small fw-semibold">
            Temp method
          </label>
          <select
            id="vit-temp-method"
            className="form-select form-select-sm"
            value={tempMethod}
            onChange={(e) => setTempMethod(e.target.value)}
            data-testid="vitals-temp-method-select"
          >
            <option value="">— Method —</option>
            <option value="Oral">Oral</option>
            <option value="Tympanic">Tympanic</option>
            <option value="Axillary">Axillary</option>
            <option value="Rectal">Rectal</option>
            <option value="Temporal">Temporal</option>
          </select>
        </div>
        <div className="col-4">
          <label htmlFor="vit-spo2" className="form-label small fw-semibold">
            SpO₂
          </label>
          <input
            id="vit-spo2"
            type="number"
            inputMode="numeric"
            className="form-control form-control-sm"
            placeholder="%"
            value={oxygenSat}
            onChange={(e) => setOxygenSat(e.target.value)}
            data-testid="vitals-spo2-input"
          />
        </div>
      </div>
      <div className="row g-2 mt-1">
        <div className="col-6">
          <label htmlFor="vit-weight" className="form-label small fw-semibold">
            Weight (lb)
          </label>
          <input
            id="vit-weight"
            type="number"
            inputMode="decimal"
            step="0.1"
            className="form-control form-control-sm"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            data-testid="vitals-weight-input"
          />
        </div>
        <div className="col-6">
          <label htmlFor="vit-height" className="form-label small fw-semibold">
            Height (in)
          </label>
          <input
            id="vit-height"
            type="number"
            inputMode="decimal"
            step="0.1"
            className="form-control form-control-sm"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            data-testid="vitals-height-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="vit-note" className="form-label small fw-semibold">
          Note
        </label>
        <textarea
          id="vit-note"
          className="form-control form-control-sm"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="vitals-note-input"
        />
      </div>
    </EditModal>
  );
}
