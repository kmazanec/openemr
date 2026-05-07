import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LegacyIframeTab } from './LegacyIframeTab';

function iframeSrc(): string {
  return screen.getByTitle(/cal/i).getAttribute('src') ?? '';
}

describe('LegacyIframeTab', () => {
  it('renders an iframe with the requested URL as src', () => {
    render(<LegacyIframeTab name="cal" url="/interface/main/calendar/index.php" active />);
    expect(iframeSrc()).toContain('/interface/main/calendar/index.php');
  });

  it('updates the iframe src when the URL prop changes', () => {
    const { rerender } = render(<LegacyIframeTab name="cal" url="/cal?date=1" active />);
    expect(iframeSrc()).toContain('date=1');

    rerender(<LegacyIframeTab name="cal" url="/cal?date=2" active />);
    expect(iframeSrc()).toContain('date=2');
  });

  it('keeps the iframe mounted but visually hidden when inactive', () => {
    render(<LegacyIframeTab name="cal" url="/cal" active={false} />);
    const iframe = screen.getByTitle(/cal/i);
    expect(iframe).toBeInTheDocument();
    const wrapper = iframe.closest('[data-testid="legacy-iframe-wrapper"]');
    expect(wrapper).not.toBeNull();
    // display: none keeps the iframe state alive (form contents,
    // scroll position) while it's not the active tab.
    expect(wrapper?.getAttribute('hidden')).not.toBeNull();
  });

  it('sets a sandbox attribute that allows same-origin and forms but not popups', () => {
    render(<LegacyIframeTab name="cal" url="/cal" active />);
    const iframe = screen.getByTitle(/cal/i);
    const sandbox = iframe.getAttribute('sandbox');
    expect(sandbox).not.toBeNull();
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).toContain('allow-forms');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-popups');
  });
});
