import type { ReactElement, MouseEvent } from 'react';

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

interface LeftNavLike {
  loadFrame?: (frameName: string, name: string, url: string) => void;
}

function openLegacyTab(
  e: MouseEvent<HTMLAnchorElement>,
  id: string,
  _label: string,
  url: string,
): void {
  if (typeof window === 'undefined') return;
  const top: (Window & { left_nav?: LeftNavLike }) | null = window.top;
  const left_nav = top?.left_nav;
  if (typeof left_nav?.loadFrame === 'function') {
    e.preventDefault();
    // Frame name maps to legacy iframe slot (e.g. 'RBot'); we don't
    // own that here. The bootShim's loadFrame path keys by `name` so
    // the same id always reuses the same tab.
    left_nav.loadFrame(`frame-${id}`, id, url);
  }
}
