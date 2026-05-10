import { useState, type ReactElement } from 'react';
import { AllergyEditModal } from '../components/AllergyEditModal';
import { ProblemEditModal } from '../components/ProblemEditModal';
import { MedicationEditModal } from '../components/MedicationEditModal';
import { PrescriptionEditModal } from '../components/PrescriptionEditModal';
import { LabResultEditModal } from '../components/LabResultEditModal';
import { VitalsEditModal } from '../components/VitalsEditModal';

/**
 * Dev-only sandbox route for the in-page edit modals. Mounts each
 * editor without requiring a FHIR session, so Playwright can exercise
 * the modal/submit/error flows against the live dashboardEditor
 * client (with the editor endpoint stubbed at the network layer).
 *
 * Excluded from the production bundle by the route registration
 * gate in routeTree.tsx — this file is only included when
 * `import.meta.env.DEV` is true.
 */
export function EditSandboxRoute(): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const close = (): void => setOpen(null);
  const saved = (label: string): void => {
    setLastSaved(label);
    setOpen(null);
  };

  return (
    <main className="container py-3" data-testid="edit-sandbox">
      <h1 className="h4">Edit Modal Sandbox</h1>
      <p className="small text-body-secondary">
        Dev-only harness for Playwright. Each button mounts the
        corresponding editor modal against a stubbed patient UUID.
      </p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('allergy')}
          data-testid="sandbox-open-allergy"
        >
          Allergy
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('problem')}
          data-testid="sandbox-open-problem"
        >
          Problem
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('medication')}
          data-testid="sandbox-open-medication"
        >
          Medication
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('prescription')}
          data-testid="sandbox-open-prescription"
        >
          Prescription
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('lab')}
          data-testid="sandbox-open-lab"
        >
          Lab
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen('vitals')}
          data-testid="sandbox-open-vitals"
        >
          Vitals
        </button>
      </div>
      {lastSaved !== null && (
        <p className="alert alert-success mt-3" data-testid="sandbox-saved">
          Saved: {lastSaved}
        </p>
      )}
      {open === 'allergy' && (
        <AllergyEditModal
          puuid="test-puuid"
          allergy={null}
          onClose={close}
          onSaved={() => saved('allergy')}
        />
      )}
      {open === 'problem' && (
        <ProblemEditModal
          puuid="test-puuid"
          problem={null}
          onClose={close}
          onSaved={() => saved('problem')}
        />
      )}
      {open === 'medication' && (
        <MedicationEditModal
          puuid="test-puuid"
          medication={null}
          onClose={close}
          onSaved={() => saved('medication')}
        />
      )}
      {open === 'prescription' && (
        <PrescriptionEditModal
          puuid="test-puuid"
          onClose={close}
          onSaved={() => saved('prescription')}
        />
      )}
      {open === 'lab' && (
        <LabResultEditModal
          puuid="test-puuid"
          onClose={close}
          onSaved={() => saved('lab')}
        />
      )}
      {open === 'vitals' && (
        <VitalsEditModal
          puuid="test-puuid"
          onClose={close}
          onSaved={() => saved('vitals')}
        />
      )}
    </main>
  );
}
