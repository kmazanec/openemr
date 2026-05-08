// Typed accessors for the legacy globals injected by main_v2.php
// (the same <script> block that exposes csrf_token_js, webroot_url,
// site_id_js, etc.). These are read once at module load — main_v2.php
// renders them inline before the SPA bundle script tag, so they are
// always defined by the time this module evaluates.

// Augment Window with the inline globals main_v2.php emits. The
// other ones (webroot_url, api_csrf_token_js) are declared in
// fhir.ts; we keep erx_enable here next to its consumer.
declare global {
  interface Window {
    erx_enable?: boolean;
    site_id_js?: string;
  }
}

function legacyGlobals(): Window {
  if (typeof window === 'undefined') return {} as Window;
  return window;
}

const ERX_ENABLED: boolean = legacyGlobals().erx_enable === true;

export function isErxEnabled(): boolean {
  return ERX_ENABLED;
}

// Test helper. Resets the cached read so a test can flip the flag
// between cases without polluting other suites.
export function _resetConfigForTests(): void {
  // No-op at runtime; cards read the constant set above. Tests that
  // need to flip the flag should set window.erx_enable BEFORE importing
  // the card module (the test harness uses vi.resetModules to make
  // this work).
}

export function webrootUrl(): string {
  return legacyGlobals().webroot_url ?? '';
}
