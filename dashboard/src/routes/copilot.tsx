import { useEffect, type ReactElement } from 'react';
import { useParams } from '@tanstack/react-router';
import { CopilotPanel } from '../components/CopilotPanel';
import { appTabsStore } from '../lib/tabsStore';

/**
 * Standalone Co-Pilot route — `/copilot/$pid`. Mounts the React
 * Co-Pilot panel as the only thing on screen; useful for direct
 * deep-links and for E2E smoke testing where the FHIR-session-gated
 * patient route can't run without a real OAuth round-trip.
 *
 * The panel's auth piggybacks on the OpenEMR PHP session cookie
 * (sent automatically with `credentials: 'same-origin'` on the
 * agent.php POST), so this route deliberately does NOT wrap itself
 * in `RequireFhirSession` — the SMART access token isn't part of the
 * Co-Pilot's auth path.
 */
export function CopilotStandaloneRoute(): ReactElement {
  const { pid } = useParams({ from: '/copilot/$pid' });
  const numericPid = Number.parseInt(pid, 10);
  // Make sure the tab is registered so the strip in any embedded
  // chrome reflects the active page; harmless when this route is the
  // only thing rendered.
  useEffect(() => {
    appTabsStore().openCopilotTab();
  }, [pid]);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return (
      <div role="alert" className="p-3">
        <h2 className="h5">Invalid patient id</h2>
        <p className="text-muted">Could not parse pid <code>{pid}</code> as a positive integer.</p>
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <CopilotPanel pid={numericPid} />
    </div>
  );
}
