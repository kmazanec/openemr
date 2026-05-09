import { describe, expect, it, vi } from 'vitest';
import { buildMenuShims, installMenuShims } from './menuShims';
import { createTabsStore } from './tabsStore';

describe('menuShims', () => {
  describe('navigateTab', () => {
    it('opens the tab in the SPA store with name+url+derived label', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      navigateTab('/cal', 'cal', undefined, 'Loading Calendar');
      const state = store.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0]).toMatchObject({
        id: 'cal',
        url: '/cal',
        label: 'Calendar',
      });
      expect(state.activeId).toBe('cal');
    });

    it('falls back to the iframe target name when no loading label is provided', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      navigateTab('/msg', 'msg');
      expect(store.getState().tabs[0]).toMatchObject({ id: 'msg', label: 'msg' });
    });

    it('falls back to the iframe target name when the label resolver returns empty', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      // "Loading" by itself (no label after the prefix) → fallback.
      navigateTab('/x', 'x', undefined, 'Loading');
      expect(store.getState().tabs[0]?.label).toBe('x');
    });

    it('invokes the after-load callback synchronously', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      const cb = vi.fn();
      navigateTab('/u', 'u', cb, 'Loading U');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('swallows callback errors so a busted handler does not break navigation', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      const cb = vi.fn(() => {
        throw new Error('boom');
      });
      expect(() => navigateTab('/u', 'u', cb)).not.toThrow();
      expect(store.getState().tabs).toHaveLength(1);
    });

    it('rejects empty/garbage inputs without mutating the store', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      navigateTab('', 'cal');
      navigateTab('/cal', '');
      expect(store.getState().tabs).toEqual([]);
    });

    it('reuses an existing tab for the same name (matches openLegacyTab semantics)', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({ tabsStore: store });
      navigateTab('/cal', 'cal', undefined, 'Loading Calendar');
      navigateTab('/cal?date=2026-05-09', 'cal', undefined, 'Loading Calendar');
      const tabs = store.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ id: 'cal', url: '/cal?date=2026-05-09' });
    });

    it('honors a custom label resolver', () => {
      const store = createTabsStore();
      const { navigateTab } = buildMenuShims({
        tabsStore: store,
        resolveLabel: (loading, name) => `${loading || name}!!`,
      });
      navigateTab('/cal', 'cal', undefined, 'X');
      expect(store.getState().tabs[0]?.label).toBe('X!!');
    });
  });

  describe('activateTabByName', () => {
    it('activates a tab by id when it exists', () => {
      const store = createTabsStore();
      store.openLegacyTab('cal', '/cal', 'Calendar');
      store.openLegacyTab('msg', '/msg', 'Messages');
      const { activateTabByName } = buildMenuShims({ tabsStore: store });
      activateTabByName('cal');
      expect(store.getState().activeId).toBe('cal');
    });

    it('is a no-op for empty / unknown names', () => {
      const store = createTabsStore();
      store.openLegacyTab('cal', '/cal');
      const { activateTabByName } = buildMenuShims({ tabsStore: store });
      const before = store.getState().activeId;
      activateTabByName('');
      activateTabByName('nope');
      expect(store.getState().activeId).toBe(before);
    });
  });

  describe('installMenuShims', () => {
    it('overwrites window.navigateTab and window.activateTabByName', () => {
      const win = { top: undefined } as unknown as Window & typeof globalThis;
      // Self-referential top so the installer's `win.top ?? win`
      // fallback finds something to assign onto.
      (win as unknown as { top: unknown }).top = win;
      // Pre-existing legacy globals — installer should overwrite.
      (win as unknown as Record<string, unknown>).navigateTab = vi.fn(() => {
        throw new Error('legacy navigateTab should not run');
      });
      (win as unknown as Record<string, unknown>).activateTabByName = vi.fn(() => {
        throw new Error('legacy activateTabByName should not run');
      });

      const store = createTabsStore();
      installMenuShims({ tabsStore: store, win });

      const w = win as unknown as {
        navigateTab: (url: string, name: string, cb?: () => void, l?: string) => void;
        activateTabByName: (name: string) => void;
      };
      w.navigateTab('/cal', 'cal', undefined, 'Loading Calendar');
      expect(store.getState().tabs[0]).toMatchObject({ id: 'cal', label: 'Calendar' });
      w.activateTabByName('cal');
      expect(store.getState().activeId).toBe('cal');
    });
  });
});
