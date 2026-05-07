import { useEffect, type ReactElement } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { appTabsStore } from '../lib/tabsStore';
import { AppShell } from '../components/AppShell';

// Activates a named legacy tab. The shimmed loadFrame call already
// pushes the tab into the store *and* navigates here; rendering this
// route directly (e.g. via a bookmark) re-registers it from the URL
// search param so the tab strip is still consistent.
//
// The actual iframe is rendered by AppShell — this route component
// just makes the URL canonical and ensures the store is populated.
export function LegacyTabRoute(): ReactElement {
  const { name } = useParams({ from: '/dashboard/legacy/$name' });
  const search = useSearch({ from: '/dashboard/legacy/$name' });
  const url = search.url ?? '';

  useEffect(() => {
    if (url.length === 0) return;
    appTabsStore().openLegacyTab(name, url);
  }, [name, url]);

  return (
    <AppShell
      dashboardBody={
        <div role="status" className="p-3">
          <p>Opening {name}…</p>
        </div>
      }
    />
  );
}
