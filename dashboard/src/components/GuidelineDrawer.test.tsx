import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GuidelineDrawer } from './GuidelineDrawer';
import type { SourceReference } from '../lib/copilotTypes';

function buildGuidelineSource(overrides: Partial<SourceReference> = {}): SourceReference {
  return {
    source_type: 'guideline',
    source_id: 'guideline-1',
    locator: { section: '2.1 Glycemic targets' },
    quote: 'Most non-pregnant adults should target an A1C of less than 7%.',
    meta: {
      publication: 'ADA Standards of Care',
      title: 'Glycemic Targets in Type 2 Diabetes',
      year: 2026,
      url: 'https://example.org/ada-glycemic-targets',
    },
    ...overrides,
  };
}

describe('GuidelineDrawer', () => {
  it('renders nothing when source is null', () => {
    const { container } = render(<GuidelineDrawer source={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the publication, title, section, quote, and link from meta', () => {
    render(
      <GuidelineDrawer
        source={buildGuidelineSource()}
        claimText="Targeting A1c below 7% is recommended."
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('copilot-guideline-publication')).toHaveTextContent(
      'ADA Standards of Care',
    );
    expect(screen.getByTestId('copilot-guideline-title')).toHaveTextContent(
      'Glycemic Targets in Type 2 Diabetes',
    );
    expect(screen.getByTestId('copilot-guideline-section')).toHaveTextContent(
      '2.1 Glycemic targets',
    );
    expect(screen.getByTestId('copilot-guideline-quote')).toHaveTextContent(
      'target an A1C of less than 7%',
    );
    expect(screen.getByTestId('copilot-guideline-link')).toHaveAttribute(
      'href',
      'https://example.org/ada-glycemic-targets',
    );
  });

  it('shows a no-link placeholder when meta.url is missing', () => {
    render(
      <GuidelineDrawer
        source={buildGuidelineSource({ meta: { publication: 'CDC' } })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('copilot-guideline-link')).toBeNull();
    expect(screen.getByTestId('copilot-guideline-nolink')).toBeInTheDocument();
  });

  it('rejects javascript: URLs (XSS hardening)', () => {
    render(
      <GuidelineDrawer
        source={buildGuidelineSource({ meta: { url: 'javascript:alert(1)' } })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('copilot-guideline-link')).toBeNull();
    expect(screen.getByTestId('copilot-guideline-nolink')).toBeInTheDocument();
  });

  it('clicking the close button or scrim or pressing Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<GuidelineDrawer source={buildGuidelineSource()} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('copilot-guideline-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('copilot-guideline-scrim'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
