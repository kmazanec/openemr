import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PatientSubNav } from './PatientSubNav';
import { _resetAppTabsStoreForTests, appTabsStore } from '../lib/tabsStore';

describe('PatientSubNav', () => {
  afterEach(() => {
    _resetAppTabsStoreForTests();
    // Reset the webroot global between tests so cross-leak doesn't
    // confuse the URL-prefix assertion.
    delete (window as unknown as { webroot_url?: unknown }).webroot_url;
  });

  it('renders all the legacy sub-nav entries', () => {
    render(<PatientSubNav pid="42" />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Report')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('External Data')).toBeInTheDocument();
  });

  it('clicking Dashboard is a no-op (we are already on the dashboard tab)', () => {
    render(<PatientSubNav pid="42" />);
    fireEvent.click(screen.getByText('Dashboard'));
    expect(appTabsStore().getState().tabs).toEqual([]);
  });

  it('clicking History opens a legacy tab in the SPA strip with id, url, and label', () => {
    render(<PatientSubNav pid="42" />);
    fireEvent.click(screen.getByText('History'));
    const tabs = appTabsStore().getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: 'history',
      url: '/interface/patient_file/history/history.php',
      label: 'History',
    });
    expect(appTabsStore().getState().activeId).toBe('history');
  });

  it('prepends top.webroot_url when one is defined on the global', () => {
    (window as unknown as { webroot_url?: string }).webroot_url = '/openemr';
    render(<PatientSubNav pid="42" />);
    fireEvent.click(screen.getByText('Documents'));
    const tab = appTabsStore().getState().tabs[0];
    expect(tab && 'url' in tab ? tab.url : null).toBe(
      '/openemr/controller.php?document&list&patient_id=42',
    );
  });

  it('Documents URL carries the encoded patient id', () => {
    render(<PatientSubNav pid="42" />);
    fireEvent.click(screen.getByText('Documents'));
    const tab = appTabsStore().getState().tabs[0];
    const url = tab && 'url' in tab ? tab.url : '';
    expect(url).toContain('patient_id=42');
  });

  it('clicking the same sub-nav entry twice reuses the existing tab (matches store semantics)', () => {
    render(<PatientSubNav pid="42" />);
    fireEvent.click(screen.getByText('History'));
    fireEvent.click(screen.getByText('History'));
    expect(appTabsStore().getState().tabs).toHaveLength(1);
  });
});
