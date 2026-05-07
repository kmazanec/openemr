import { useSyncExternalStore } from 'react';
import { appTabsStore, type TabsState, type TabsStore } from './tabsStore';

export function useTabs(store: TabsStore = appTabsStore()): TabsState {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.getState(),
    () => store.getState(),
  );
}
