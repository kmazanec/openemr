import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

/**
 * Reusable modal-dialog scaffolding for the dashboard's in-page edit
 * forms (allergies, problems, medications, prescriptions, lab
 * results, vitals).
 *
 * Mirrors the GuidelineDrawer Escape/scrim pattern but presents
 * centered (a form is denser than a side-by-side viewer, and the
 * dashboard's grid behind the scrim is what the doctor wants to see
 * when verifying their input). Focus is moved into the dialog on
 * mount and trapped by the host page's tab order — keeping focus
 * trap minimal here mirrors how Bootstrap's own `.modal` works.
 *
 * The form inside is the caller's concern: pass children with the
 * fields, plus an `onSubmit` and an `onClose`. The save button is
 * provided here so the spinner-state UX is consistent across forms.
 */
export interface EditModalProps {
  open: boolean;
  title: string;
  saveLabel?: string;
  saving?: boolean;
  saveDisabled?: boolean;
  error?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}

export function EditModal({
  open,
  title,
  saveLabel = 'Save',
  saving = false,
  saveDisabled = false,
  error = null,
  onSubmit,
  onClose,
  children,
  testId = 'dashboard-edit-modal',
}: EditModalProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Move focus to the first focusable element inside the modal
    // after the next paint so screen readers settle first.
    const raf = window.requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (root === null) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables[0];
      if (first !== undefined) first.focus();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.cancelAnimationFrame(raf);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="dashboard-edit-modal__scrim"
        data-testid={`${testId}-scrim`}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 1040,
        }}
      />
      <div
        ref={dialogRef}
        className="dashboard-edit-modal shadow"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={{
          position: 'fixed',
          top: '8vh',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(540px, 92vw)',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          borderRadius: 6,
          zIndex: 1050,
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          style={{ display: 'contents' }}
        >
          <header className="d-flex align-items-center justify-content-between px-3 py-2 border-bottom">
            <h2 className="h6 mb-0" data-testid={`${testId}-title`}>
              {title}
            </h2>
            <button
              type="button"
              className="btn-close"
              aria-label="Close"
              data-testid={`${testId}-close`}
              onClick={onClose}
              disabled={saving}
            />
          </header>

          <div className="flex-grow-1 overflow-auto p-3" data-testid={`${testId}-body`}>
            {children}
            {error !== null && error !== '' && (
              <div
                className="alert alert-danger mt-3 mb-0 py-2 px-3 small"
                role="alert"
                data-testid={`${testId}-error`}
              >
                {error}
              </div>
            )}
          </div>

          <footer className="d-flex justify-content-end gap-2 px-3 py-2 border-top">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={onClose}
              disabled={saving}
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={saving || saveDisabled}
              data-testid={`${testId}-save`}
            >
              {saving ? 'Saving…' : saveLabel}
            </button>
          </footer>
        </form>
      </div>
    </>
  );
}
