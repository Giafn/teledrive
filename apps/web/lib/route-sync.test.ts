import { describe, expect, it, vi } from 'vitest';
import { navigateRoute, parseRoute, routeToPath } from './route-sync';

describe('route-sync', () => {
  it('parses view paths', () => {
    expect(parseRoute('/', '')).toEqual({ view: 'drive' });
    expect(parseRoute('/recent/', '')).toEqual({ view: 'recent' });
    expect(parseRoute('/trash/', '')).toEqual({ view: 'trash' });
    expect(parseRoute('/settings/', '')).toEqual({ view: 'settings' });
  });

  it('parses folder deep links with query id', () => {
    expect(parseRoute('/f/', '?id=abc123')).toEqual({ view: 'drive', folderId: 'abc123' });
    expect(parseRoute('/f/', '')).toEqual({ view: 'drive' });
  });

  it('falls back to drive for unknown paths', () => {
    expect(parseRoute('/nope/', '')).toEqual({ view: 'drive' });
  });

  it('builds canonical paths', () => {
    expect(routeToPath({ view: 'drive' })).toBe('/');
    expect(routeToPath({ view: 'recent' })).toBe('/recent/');
    expect(routeToPath({ view: 'trash' })).toBe('/trash/');
    expect(routeToPath({ view: 'settings' })).toBe('/settings/');
    expect(routeToPath({ view: 'drive', folderId: 'abc 123' })).toBe('/f/?id=abc%20123');
  });

  it('pushes history without duplicating current path', () => {
    const pushState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '' },
      history: { pushState },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('PopStateEvent', class PopStateEvent extends Event {
      constructor(type: string) {
        super(type);
      }
    });
    try {
      navigateRoute({ view: 'recent' });
      expect(pushState).toHaveBeenCalledWith(null, '', '/recent/');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
