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
    <ul className="nav nav-tabs" role="tablist" data-testid="tab-strip">
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
    <li className="nav-item d-flex align-items-center" role="presentation">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className={`nav-link ${active ? 'active' : ''}`}
        onClick={() => {
          store.setActive(tab.id);
        }}
      >
        {tab.label}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-link text-decoration-none px-1 py-0"
        aria-label={`Close ${tab.label}`}
        onClick={() => {
          store.closeTab(tab.id);
        }}
      >
        &times;
      </button>
    </li>
  );
}
