import type { ReactElement } from 'react';
import type { Bundle, BundleEntry, HumanName, Patient } from '@medplum/fhirtypes';
import { useFhirRequest } from '../lib/useFhirRequest';

export interface DashboardPageHeaderProps {
  pid: string;
}

export function DashboardPageHeader({ pid }: DashboardPageHeaderProps): ReactElement {
  const { data } = useFhirRequest<Bundle<Patient>>(
    `Patient?identifier=${encodeURIComponent(pid)}`,
  );
  const name = data !== undefined ? formatName(firstEntry(data)?.name) : '';

  return (
    <div className="d-flex align-items-center justify-content-between py-3" data-testid="dashboard-page-header">
      <h2 className="h4 mb-0 fw-semibold">
        Medical Record Dashboard{name.length > 0 ? ` - ${name}` : ''}
      </h2>
      <div className="d-flex align-items-center gap-2 text-body-secondary">
        <button
          type="button"
          className="btn btn-sm btn-link text-body-secondary p-0"
          aria-label="Collapse all"
          title="Collapse all"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M5.293 6.707a1 1 0 0 1 0-1.414L7.586 3 5.293.707a1 1 0 0 1 1.414-1.414l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414 0z" transform="rotate(45 8 8)" />
            <path d="M3.5 9.5h9v1h-9zm0-3h9v1h-9z" />
          </svg>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-link text-body-secondary p-0"
          aria-label="Help"
          title="Help"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
            <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function firstEntry(bundle: Bundle<Patient> | undefined): Patient | undefined {
  if (bundle === undefined) return undefined;
  const entries = bundle.entry;
  if (entries === undefined || entries.length === 0) return undefined;
  const first: BundleEntry<Patient> | undefined = entries[0];
  return first?.resource;
}

function formatName(names: HumanName[] | undefined): string {
  if (names === undefined || names.length === 0) return '';
  const primary = names.find((n) => n.use === 'official') ?? names[0];
  if (primary === undefined) return '';
  if (typeof primary.text === 'string' && primary.text.length > 0) return primary.text;
  const given = primary.given?.join(' ') ?? '';
  const family = primary.family ?? '';
  return `${given} ${family}`.trim();
}
