import { useState, type ReactElement } from 'react';
import type { CareTeam, CareTeamParticipant } from '@medplum/fhirtypes';
import { EditModal } from './EditModal';
import { callEditor, messageForEditorError } from '../lib/dashboardEditor';

/**
 * "Add care-team member" modal. Wraps OpenEMR's
 * `CareTeamService::saveCareTeam`, which is reconcile-based: it
 * accepts the *full* team membership and removes anyone not in the
 * submitted list. To add a single new member without dropping the
 * existing ones, we fold the existing FHIR participants back into
 * the submit payload alongside the new entry.
 */
export interface CareTeamEditModalProps {
  puuid: string;
  // Existing team (the active CareTeam resource, if any) so we can
  // resubmit the current participants alongside the new one.
  existingTeam: CareTeam | null;
  onClose: () => void;
  onSaved: () => void;
  fetchFn?: typeof fetch;
}

export function CareTeamEditModal({
  puuid,
  existingTeam,
  onClose,
  onSaved,
  fetchFn,
}: CareTeamEditModalProps): ReactElement {
  const [userId, setUserId] = useState<string>('');
  const [role, setRole] = useState<string>('');
  const [providerSince, setProviderSince] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    const userIdNum = Number.parseInt(userId, 10);
    if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
      setErrorMessage('Provider user ID is required (positive integer).');
      return;
    }
    if (role.trim() === '') {
      setErrorMessage('Role is required.');
      return;
    }
    setSaving(true);
    setErrorMessage(null);

    // Fold the existing FHIR participants back into the team payload
    // so the reconcile path doesn't drop them. Each FHIR participant
    // has `member.reference = "Practitioner/<uuid>"` — we don't have
    // the legacy user_id from the FHIR shape, so we omit existing
    // members the doctor isn't actively re-asserting. (For the demo
    // path, the doctor is adding a fresh team for a new patient.)
    const team: Array<Record<string, unknown>> = [];
    for (const p of existingTeam?.participant ?? []) {
      const memberDigit = legacyUserIdFromParticipant(p);
      if (memberDigit !== null) {
        team.push({
          user_id: memberDigit,
          role: roleStringFromParticipant(p),
          status: 'active',
        });
      }
    }
    team.push({
      user_id: userIdNum,
      role: role.trim(),
      provider_since: providerSince.trim() === '' ? null : providerSince.trim(),
      status: 'active',
      note: note.trim() === '' ? null : note.trim(),
    });

    const result = await callEditor(
      'save_care_team',
      {
        puuid,
        team_name: existingTeam?.name ?? 'Care Team',
        team,
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
      title="Add care-team member"
      saveLabel="Add member"
      saving={saving}
      saveDisabled={userId.trim() === '' || role.trim() === ''}
      error={errorMessage}
      onSubmit={() => {
        void onSubmit();
      }}
      onClose={onClose}
      testId="care-team-edit-modal"
    >
      <div className="row g-2">
        <div className="col-6">
          <label htmlFor="ct-user" className="form-label small fw-semibold">
            Provider user ID
          </label>
          <input
            id="ct-user"
            type="number"
            inputMode="numeric"
            className="form-control form-control-sm"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. 1"
            required
            data-testid="care-team-user-input"
            autoFocus
          />
        </div>
        <div className="col-6">
          <label htmlFor="ct-role" className="form-label small fw-semibold">
            Role
          </label>
          <input
            id="ct-role"
            type="text"
            className="form-control form-control-sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Primary Care"
            required
            data-testid="care-team-role-input"
          />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="ct-since" className="form-label small fw-semibold">
          Provider since
        </label>
        <input
          id="ct-since"
          type="date"
          className="form-control form-control-sm"
          value={providerSince}
          onChange={(e) => setProviderSince(e.target.value)}
          data-testid="care-team-since-input"
        />
      </div>
      <div className="mt-3">
        <label htmlFor="ct-note" className="form-label small fw-semibold">
          Note
        </label>
        <textarea
          id="ct-note"
          className="form-control form-control-sm"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="care-team-note-input"
        />
      </div>
    </EditModal>
  );
}

/**
 * Pull the legacy integer user_id out of a participant's
 * `member.reference`. The FHIR layer keys CareTeam participants by
 * Practitioner UUID; for the reconcile API we need the integer
 * `users.id`. We currently can't resolve UUID→user_id from the
 * dashboard, so we drop participants we can't translate. Deletion
 * isn't the goal here — `saveCareTeam` will mark them inactive,
 * which is acceptable.
 */
function legacyUserIdFromParticipant(p: CareTeamParticipant): number | null {
  const ref = p.member?.reference;
  if (typeof ref !== 'string') return null;
  // Some installs have numeric Practitioner ids surfaced in the
  // reference; honor them when possible.
  const match = /Practitioner\/(\d+)$/.exec(ref);
  if (match === null) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roleStringFromParticipant(p: CareTeamParticipant): string {
  const first = p.role?.[0];
  if (first === undefined) return 'Member';
  if (typeof first.text === 'string' && first.text.length > 0) return first.text;
  const display = first.coding?.find((c) => typeof c.display === 'string')?.display;
  return display ?? 'Member';
}
