export type AppRoute = { view: 'drive' | 'recent' | 'trash' | 'settings'; folderId?: string };

export function parseRoute(pathname: string, search: string): AppRoute {
  const path = pathname.replace(/\/+$/u, '') || '/';
  if (path === '/recent') return { view: 'recent' };
  if (path === '/trash') return { view: 'trash' };
  if (path === '/settings') return { view: 'settings' };
  if (path === '/f') {
    const id = new URLSearchParams(search).get('id');
    if (id) return { view: 'drive', folderId: id };
    return { view: 'drive' };
  }
  return { view: 'drive' };
}

export function routeToPath(route: AppRoute): string {
  if (route.view === 'recent') return '/recent/';
  if (route.view === 'trash') return '/trash/';
  if (route.view === 'settings') return '/settings/';
  if (route.folderId) return `/f/?id=${encodeURIComponent(route.folderId)}`;
  return '/';
}

export function currentRoute(): AppRoute {
  if (typeof window === 'undefined') return { view: 'drive' };
  return parseRoute(window.location.pathname, window.location.search);
}

export function navigateRoute(route: AppRoute): void {
  if (typeof window === 'undefined') return;
  const path = routeToPath(route);
  if (window.location.pathname + window.location.search === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function applyRoute(route: AppRoute): void {
  if (typeof window === 'undefined') return;
  const path = routeToPath(route);
  if (window.location.pathname + window.location.search === path) return;
  window.history.replaceState(null, '', path);
}
