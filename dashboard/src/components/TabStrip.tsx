import type { ReactElement } from 'react';
import { appTabsStore, type Tab, type TabsStore } from '../lib/tabsStore';
import { useTabs } from '../lib/useTabs';

export interface TabStripProps {
  store?: TabsStore;
}

export function TabStrip({ store }: TabStripProps): ReactElement {
  const resolved = store ?? appTabsStore();
  const state = useTabs(resolved);

  return (
    <ul
      className="nav tab-strip-legacy d-flex align-items-end mb-0 px-3 small"
      role="tablist"
      data-testid="tab-strip"
    >
      {state.tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={state.activeId === tab.id}
          store={resolved}
        />
      ))}
    </ul>
  );
}

function TabItem({
  tab,
  active,
  store,
}: {
  tab: Tab;
  active: boolean;
  store: TabsStore;
}): ReactElement {
  return (
    <li
      className={`nav-item d-flex align-items-center gap-1 px-2 py-1 border ${active ? 'border-bottom-0 bg-body fw-semibold' : 'border-transparent text-body-secondary'}`}
      role="presentation"
      style={{
        marginBottom: active ? -1 : 0,
        borderTopLeftRadius: 4,
        borderTopRightRadius: 4,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="btn btn-link p-0 text-decoration-none text-reset"
        onClick={() => {
          store.setActive(tab.id);
        }}
      >
        {tab.label}
      </button>
      <RefreshIcon />
      <LockIcon />
      <button
        type="button"
        className="btn btn-link p-0 text-decoration-none text-body-secondary"
        aria-label={`Close ${tab.label}`}
        title={`Close ${tab.label}`}
        onClick={() => {
          store.closeTab(tab.id);
        }}
      >
        &times;
      </button>
    </li>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-body-secondary"
      aria-hidden="true"
    >
      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z" />
      <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
    </svg>
  );
}

function LockIcon(): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-body-secondary"
      aria-hidden="true"
    >
      <path d="M8 1a2 2 0 0 0-2 2v4H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2zm3 6V3a3 3 0 1 0-6 0v4h6z" />
    </svg>
  );
}
