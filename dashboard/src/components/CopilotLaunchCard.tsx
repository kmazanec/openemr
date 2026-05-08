import type { ReactElement } from 'react';
import { appTabsStore } from '../lib/tabsStore';

export interface CopilotLaunchCardProps {
  pid: string;
}

/**
 * Top-of-dashboard banner that opens the Clinical Co-Pilot tab. The
 * tab itself renders a SPA-native chat panel (no iframe). This is a
 * deliberate single-call-to-action — the doctor wants the briefing on
 * a click, not on every chart open, so we don't auto-open the tab.
 *
 * The card matches the rest of the dashboard's chrome (BS5 utilities)
 * and stays inside the existing card grid so it scrolls with the rest
 * of the patient summary.
 */
export function CopilotLaunchCard({ pid }: CopilotLaunchCardProps): ReactElement {
  return (
    <div
      className="card border-primary-subtle shadow-sm"
      data-testid="copilot-launch-card"
      data-pid={pid}
    >
      <div className="card-body d-flex align-items-center justify-content-between gap-3 flex-wrap">
        <div className="d-flex align-items-center gap-3">
          <span className="display-6" aria-hidden="true">🩺</span>
          <div>
            <h2 className="h6 mb-1 text-primary">Clinical Co-Pilot</h2>
            <p className="mb-0 small text-body-secondary">
              Ask the AI agent for a 90-second briefing on this patient, or follow up
              with free-text questions. Citations are surfaced inline.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="copilot-launch-button"
          onClick={() => {
            appTabsStore().openCopilotTab();
          }}
        >
          Open Co-Pilot
        </button>
      </div>
    </div>
  );
}
