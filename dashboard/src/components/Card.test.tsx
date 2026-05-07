import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Card } from './Card';

describe('Card', () => {
  it('renders title and children', () => {
    render(
      <Card title="Allergies">
        <p>body</p>
      </Card>,
    );
    expect(screen.getByText('Allergies')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders a plain anchor for the view-all link (full reload, not router nav)', () => {
    render(
      <Card title="Allergies" viewAllHref="/interface/patient_file/summary/stats_full.php?category=allergy">
        body
      </Card>,
    );
    const link = screen.getByRole('link', { name: /view all/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe(
      '/interface/patient_file/summary/stats_full.php?category=allergy',
    );
    expect(link.tagName).toBe('A');
  });

  it('omits the view-all link when no href is provided', () => {
    render(<Card title="Allergies">body</Card>);
    expect(screen.queryByRole('link', { name: /view all/i })).not.toBeInTheDocument();
  });

  it('renders a card-level error state with a retry button', () => {
    const onRetry = vi.fn();
    render(
      <Card title="Allergies" error={new Error('boom')} onRetry={onRetry}>
        body
      </Card>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load Allergies/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/i });
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a skeleton while loading=true', () => {
    render(
      <Card title="Allergies" loading>
        body
      </Card>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-skeleton')).toBeInTheDocument();
  });
});
