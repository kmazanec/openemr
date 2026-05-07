import type { ReactElement } from 'react';

export interface LegacyIframeTabProps {
  name: string;
  url: string;
  active: boolean;
}

// Hosts a legacy OpenEMR URL in a sandboxed iframe. The wrapper stays
// mounted across tab switches (display: none) so reopening a tab is
// instant and form state survives. allow-popups is intentionally
// omitted — legacy code that relied on `window.open(...)` from a
// hosted iframe goes through the dlgopen shim instead.
//
// Title shim handling for `top.document.title = ...` lands when T6.1
// adds the global error/title boundary; this component only owns the
// iframe DOM.
export function LegacyIframeTab({ name, url, active }: LegacyIframeTabProps): ReactElement {
  return (
    <div
      data-testid="legacy-iframe-wrapper"
      hidden={!active}
      className="legacy-iframe-tab h-100"
    >
      <iframe
        title={`legacy-tab-${name}`}
        src={url}
        sandbox="allow-same-origin allow-forms allow-scripts"
        className="w-100 h-100 border-0"
      />
    </div>
  );
}
