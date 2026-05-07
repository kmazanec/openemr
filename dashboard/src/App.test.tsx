import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DashboardLanding } from './routes/dashboardLanding';
import { _resetAppTabsStoreForTests } from './lib/tabsStore';

describe('<DashboardLanding />', () => {
  beforeEach(() => {
    _resetAppTabsStoreForTests();
  });

  it('renders the dashboard landing heading when there are no seeded tabs', () => {
    render(<DashboardLanding />);
    expect(screen.getByRole('heading', { name: /patient dashboard/i })).toBeInTheDocument();
  });
});
