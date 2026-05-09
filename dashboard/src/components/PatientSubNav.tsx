import type { ReactElement, MouseEvent } from 'react';
import { appTabsStore } from '../lib/tabsStore';

export interface PatientSubNavProps {
  pid: string;
}

interface SubNavLink {
  id: string;
  label: string;
  // Function so links that need {pid} can build a URL per-patient.
  url: (pid: string) => string;
  // Children render as a dropdown menu.
  children?: ReadonlyArray<SubNavLink>;
}

// Mirrors the legacy patient sub-menu order from
// interface/main/tabs/menu/menus/patient_menus/standard.json. The
// Dashboard entry is intentionally a no-op — this row is rendered
// when the dashboard is already the active tab, so 'Dashboard'
// becomes a label, not a link.
const SUB_NAV: ReadonlyArray<SubNavLink> = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    url: () => '',
  },
  {
    id: 'history',
    label: 'History',
    url: () => '/interface/patient_file/history/history.php',
  },
  {
    id: 'assessments',
    label: 'Assessments',
    url: () => '',
    children: [
      {
        id: 'sdoh',
        label: 'SDOH Assessment',
        url: (pid) => `/interface/patient_file/history/history_sdoh_widget.php?pid=${encodeURIComponent(pid)}`,
      },
    ],
  },
  {
    id: 'report',
    label: 'Report',
    url: () => '/interface/patient_file/report/patient_report.php',
  },
  {
    id: 'documents',
    label: 'Documents',
    url: (pid) =>
      `/controller.php?document&list&patient_id=${encodeURIComponent(pid)}`,
  },
  {
    id: 'transactions',
    label: 'Transactions',
    url: () => '/interface/patient_file/transaction/transactions.php',
  },
  {
    id: 'issues',
    label: 'Issues',
    url: () => '/interface/patient_file/summary/stats_full.php?active=all',
  },
  {
    id: 'ledger',
    label: 'Ledger',
    url: (pid) =>
      `/interface/reports/pat_ledger.php?form=1&patient_id=${encodeURIComponent(pid)}`,
  },
  {
    id: 'external-data',
    label: 'External Data',
    url: () => '/interface/reports/external_data.php',
  },
];

export function PatientSubNav({ pid }: PatientSubNavProps): ReactElement {
  return (
    <nav
      className="patient-sub-nav d-flex flex-wrap gap-3 px-3 py-2 small"
      data-testid="patient-sub-nav"
      aria-label="Patient record sections"
    >
      {SUB_NAV.map((item) =>
        item.children !== undefined ? (
          <DropdownItem key={item.id} item={item} pid={pid} />
        ) : (
          <SubNavItem key={item.id} item={item} pid={pid} />
        ),
      )}
    </nav>
  );
}

function SubNavItem({ item, pid }: { item: SubNavLink; pid: string }): ReactElement {
  const isDashboardSelf = item.id === 'dashboard';
  return (
    <a
      href={isDashboardSelf ? '#' : item.url(pid)}
      className={`text-decoration-none ${isDashboardSelf ? 'fw-semibold text-body' : 'text-body-secondary'}`}
      onClick={(e) => {
        if (isDashboardSelf) {
          e.preventDefault();
          return;
        }
        openLegacyTab(e, item.id, item.label, item.url(pid));
      }}
    >
      {item.label}
    </a>
  );
}

function DropdownItem({ item, pid }: { item: SubNavLink; pid: string }): ReactElement {
  return (
    <div className="dropdown">
      <a
        href="#"
        className="text-decoration-none text-body-secondary dropdown-toggle"
        data-bs-toggle="dropdown"
        aria-expanded="false"
        onClick={(e) => {
          // Bootstrap data-bs-toggle handles the open/close; we just
          // suppress navigation.
          e.preventDefault();
        }}
      >
        {item.label}
      </a>
      <ul className="dropdown-menu">
        {item.children?.map((child) => (
          <li key={child.id}>
            <a
              href={child.url(pid)}
              className="dropdown-item"
              onClick={(e) => openLegacyTab(e, child.id, child.label, child.url(pid))}
            >
              {child.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Open a sub-nav target in the SPA tab strip. SubNav clicks are
// SPA-internal (we own both ends of the call), so we go straight to
// the tabs store rather than round-tripping through `top.left_nav.
// loadFrame` like a legacy iframe would. We also resolve the URL
// against `top.webroot_url` when one is defined — main_v2.php emits
// it on `window` so legacy iframes have an absolute base; SubNav
// links live on the same shell and benefit from the same prefix.
function openLegacyTab(
  e: MouseEvent<HTMLAnchorElement>,
  id: string,
  label: string,
  url: string,
): void {
  if (typeof window === 'undefined') return;
  e.preventDefault();
  const webroot = readWebRoot();
  const fullUrl = url.startsWith('http') || url.startsWith('//')
    ? url
    : `${webroot}${url.startsWith('/') ? '' : '/'}${url}`;
  appTabsStore().openLegacyTab(id, fullUrl, label);
}

function readWebRoot(): string {
  if (typeof window === 'undefined') return '';
  const top = (window.top ?? window) as Window & { webroot_url?: unknown };
  const wr = top.webroot_url;
  return typeof wr === 'string' ? wr : '';
}
