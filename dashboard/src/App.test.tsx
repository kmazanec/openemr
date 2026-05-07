import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardLanding } from './routes/dashboardLanding';

describe('<DashboardLanding />', () => {
  it('renders the dashboard landing heading', () => {
    render(<DashboardLanding />);
    expect(screen.getByRole('heading', { name: /patient dashboard/i })).toBeInTheDocument();
  });
});
