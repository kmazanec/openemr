import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CopilotLaunchCard } from './CopilotLaunchCard';
import {
  COPILOT_TAB_ID,
  appTabsStore,
  _resetAppTabsStoreForTests,
} from '../lib/tabsStore';

describe('CopilotLaunchCard', () => {
  afterEach(() => {
    _resetAppTabsStoreForTests();
  });

  it('renders the title and CTA button', () => {
    render(<CopilotLaunchCard pid="42" />);
    expect(screen.getByText('Clinical Co-Pilot')).toBeInTheDocument();
    expect(screen.getByTestId('copilot-launch-button')).toHaveTextContent('Open Co-Pilot');
  });

  it('clicking the button opens the Co-Pilot tab', () => {
    render(<CopilotLaunchCard pid="42" />);
    expect(appTabsStore().getState().tabs).toEqual([]);
    fireEvent.click(screen.getByTestId('copilot-launch-button'));
    const state = appTabsStore().getState();
    expect(state.tabs.map((t) => t.id)).toEqual([COPILOT_TAB_ID]);
    expect(state.activeId).toBe(COPILOT_TAB_ID);
  });
});
