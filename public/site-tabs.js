// Shared site tab bar for both dashboards.
//
// The tabs are built from GET /api/sites rather than hardcoded in the HTML, so
// a site added to lib/sites.js appears on both pages without touching markup.
// The selection is mirrored into ?site= and localStorage so switching tabs and
// then following the Live ↔ Analytics link keeps you on the same site.
const SiteTabs = (() => {
  const STORAGE_KEY = 'crash.site';
  const FALLBACK = [{ key: 'stake', label: 'STAKE', tab: 'Stake.com', enabled: true }];
  let sites = FALLBACK;

  async function load() {
    try {
      const res = await fetch('/api/sites');
      const json = await res.json();
      if (Array.isArray(json) && json.length) sites = json;
    } catch (e) {
      console.error('Falling back to a single site — /api/sites failed:', e);
    }
    return sites;
  }

  const known = (key) => sites.some(s => s.key === key);

  // URL wins over the remembered tab, so a shared link always opens its site.
  function initial() {
    const fromUrl = new URLSearchParams(location.search).get('site');
    if (fromUrl && known(fromUrl)) return fromUrl;
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored && known(stored)) return stored;
    return sites[0].key;
  }

  function remember(key) {
    try { localStorage.setItem(STORAGE_KEY, key); } catch (e) {}
    const url = new URL(location.href);
    url.searchParams.set('site', key);
    history.replaceState(null, '', url);
    // Carry the site across the Live ↔ Analytics link.
    document.querySelectorAll('a.nav-link[data-keep-site]').forEach(a => {
      const target = new URL(a.getAttribute('href'), location.href);
      target.searchParams.set('site', key);
      a.setAttribute('href', target.pathname + target.search);
    });
  }

  function find(key) {
    return sites.find(s => s.key === key) || sites[0];
  }

  // Renders the bar and wires the clicks. onChange fires only on a real change.
  function render(container, active, onChange) {
    container.innerHTML = '';
    sites.forEach(site => {
      const btn = document.createElement('button');
      btn.dataset.site = site.key;
      btn.className = site.key === active ? 'active' : '';
      btn.textContent = site.tab || site.label;
      // A site left running as archive-only still has data worth browsing, so
      // the tab stays clickable and is only marked.
      if (site.enabled === false) {
        btn.title = 'Capture disabled — showing archived data only';
        const dot = document.createElement('span');
        dot.className = 'tab-offline';
        btn.appendChild(dot);
      }
      btn.onclick = () => {
        if (btn.classList.contains('active')) return;
        container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        remember(site.key);
        onChange(site.key);
      };
      container.appendChild(btn);
    });
    remember(active);
  }

  return { load, initial, render, find, get sites() { return sites; } };
})();
