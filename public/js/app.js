// FraudLens MVP — UI, scanning and persistence. Detection logic lives in detect.js.
import * as D from './detect.js';
import { renderView } from './views.js';

/* ---------------- state ---------------- */

export const S = {
  brand: { ...D.EMPTY_BRAND },
  watchlist: { instagram: [], appTerms: [] },
  findings: { items: {}, activity: [] },
  scans: { instagram: null, appstore: null },
  config: {},
  busy: null, // { kind, done, total, label }
  route: 'dashboard'
};

/* ---------------- helpers ---------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const fmt = (n) => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n));
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
export function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}
export const sevClass = (s) => ({ High: 'hi', Medium: 'md', Low: 'lo' }[s] || 'in');
export const imgSrc = (u) => (!u ? '' : u.startsWith('data:') ? u : '/api/img?u=' + encodeURIComponent(u));

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `Request failed (${res.status})`); e.code = json.code; e.status = res.status; throw e; }
  return json;
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3800);
}

export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------- modal ---------------- */

let lastFocus = null;
export function openModal(html, { label = 'Details', onOpen } = {}) {
  lastFocus = document.activeElement;
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-wrap" data-close><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1">${html}</div></div>`;
  const modal = $('.modal', root);
  modal.focus();
  root.firstElementChild.addEventListener('mousedown', (e) => { if (e.target.hasAttribute('data-close')) closeModal(); });
  $$('[data-dismiss]', root).forEach((b) => b.addEventListener('click', closeModal));
  onOpen?.(modal);
}
export function closeModal() {
  $('#modalRoot').innerHTML = '';
  lastFocus?.focus?.();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('#modalRoot').innerHTML) closeModal(); else closeMenu(); }
  if (e.key === 'Tab' && $('#modalRoot .modal')) { // keep focus inside the dialog
    const f = $$('#modalRoot button, #modalRoot a[href], #modalRoot input, #modalRoot select, #modalRoot textarea').filter((x) => !x.disabled);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});

/* ---------------- image fingerprints (dHash, computed in the browser) ---------------- */

const hashCache = new Map();
export function hashImage(url) {
  if (!url) return Promise.resolve(null);
  const src = imgSrc(url);
  if (hashCache.has(src)) return hashCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 9; c.height = 8;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        // centre-crop to a square so a square logo and a circular avatar line up
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 9, 8);
        const d = ctx.getImageData(0, 0, 9, 8).data;
        const g = []; for (let i = 0; i < d.length; i += 4) g.push(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        let bits = '';
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0';
        resolve(bits);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  hashCache.set(src, p);
  return p;
}

/** Shrink an uploaded logo to 256 px so it stores small. */
export function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image.'));
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        if (s < 64) return reject(new Error('Logo must be at least 64 × 64 pixels.'));
        const c = document.createElement('canvas'); c.width = c.height = 256;
        c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 256, 256);
        resolve(c.toDataURL('image/png'));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* ---------------- persistence ---------------- */

export async function loadState() {
  const st = await api('/api/state');
  Object.assign(S, { brand: { ...D.EMPTY_BRAND, ...st.brand }, watchlist: st.watchlist, findings: st.findings, scans: st.scans, config: st.config });
  if (!S.findings.items) S.findings.items = {};
  if (!S.findings.activity) S.findings.activity = [];
  if (S.brand.logo && !S.brand.logoHash) { S.brand.logoHash = (await hashImage(S.brand.logo)) || ''; if (S.brand.logoHash) await saveBrand(false); }
}
export const saveBrand = (quiet = true) => api('/api/brand', { method: 'PUT', body: S.brand }).then(() => { if (!quiet) chrome(); });
export const saveWatchlist = () => api('/api/watchlist', { method: 'PUT', body: S.watchlist });
export const saveFindings = () => api('/api/findings', { method: 'PUT', body: S.findings });

export function logActivity(text, kind = 'info') {
  S.findings.activity.unshift({ at: Date.now(), text, kind });
  S.findings.activity = S.findings.activity.slice(0, 80);
}

export function finding(key) {
  return S.findings.items[key] || (S.findings.items[key] = { status: 'New', firstSeen: Date.now(), history: [] });
}
export async function setStatus(key, status) {
  const f = finding(key);
  if (f.status === status) return;
  f.status = status; f.history.push({ at: Date.now(), text: 'Status set to ' + status });
  logActivity(`${key.replace(/^ig:/, '@').replace(/^app:/, 'App ')} marked ${status}`);
  await saveFindings(); chrome();
  toast('Status: ' + status);
}

/* ---------------- brand context ---------------- */

export function brandReady() { return !!(S.brand.name && ((S.brand.instagram || []).length || (S.brand.apps || []).length)); }

/* ---------------- Instagram scan ---------------- */

export function setBusy(b) { S.busy = b; renderProgress(); }
function renderProgress() {
  const el = $('#progress');
  if (!el) return;
  if (!S.busy) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const pct = S.busy.total ? Math.round(100 * S.busy.done / S.busy.total) : 5;
  el.innerHTML = `<div class="row"><strong>${esc(S.busy.label)}</strong><span class="spacer"></span><span class="small">${S.busy.done} / ${S.busy.total}</span></div><div class="bar"><div style="width:${pct}%"></div></div>`;
}

async function fetchProfile(handle, fresh = false) {
  return api('/api/instagram/profile?username=' + encodeURIComponent(handle) + (fresh ? '&fresh=1' : ''));
}

/** Fetch the official accounts so we know their IDs, pictures and posts. */
async function officialContext(onStep) {
  const ctx = { officialIds: [], officialMaxId: null, logoHashes: [], officialPosts: [], status: [] };
  if (S.brand.logoHash) ctx.logoHashes.push({ label: 'your logo', hash: S.brand.logoHash });
  for (const h of S.brand.instagram || []) {
    onStep?.('Reading official @' + h);
    try {
      const { profile, cached, stale } = await fetchProfile(h);
      ctx.status.push({ handle: h, ok: true, verified: profile.isVerified, followers: profile.followers, cached, stale, limited: !!profile.limited });
      if (profile.id) { ctx.officialIds.push(profile.id); if (/^\d+$/.test(profile.id) && (!ctx.officialMaxId || BigInt(profile.id) > BigInt(ctx.officialMaxId))) ctx.officialMaxId = profile.id; }
      const ph = await hashImage(profile.profilePic);
      if (ph) ctx.logoHashes.push({ label: `@${h}'s profile picture`, hash: ph });
      for (const p of (profile.posts || []).slice(0, 12)) ctx.officialPosts.push({ handle: h, shortcode: p.shortcode, caption: p.caption, takenAt: p.takenAt, thumbHash: await hashImage(p.thumb) });
    } catch (e) { ctx.status.push({ handle: h, ok: false, error: e.message }); }
  }
  return ctx;
}

export async function scanInstagram({ handles } = {}) {
  if (S.busy) return toast('A scan is already running.');
  if (!brandReady()) { toast('Set up the brand profile first.', 'err'); location.hash = '#/brand'; return; }
  const list = [...new Set((handles || S.watchlist.instagram || []).map(D.parseHandle).filter(Boolean))];
  if (!list.length) return toast('Add Instagram usernames to the watchlist first.', 'err');
  const total = list.length + (S.brand.instagram || []).length;
  let done = 0;
  setBusy({ kind: 'instagram', done, total, label: 'Reading official accounts…' });
  try {
    const off = await officialContext((label) => { setBusy({ kind: 'instagram', done: done++, total, label }); });
    const brand = D.compileBrand(S.brand, { officialIds: off.officialIds, officialMaxId: off.officialMaxId, officialPosts: off.officialPosts });
    const results = [];
    for (const h of list) {
      setBusy({ kind: 'instagram', done: done++, total, label: 'Checking @' + h });
      try {
        const { profile, cached, stale, warning, cachedAt } = await fetchProfile(h);
        profile.pfpHash = await hashImage(profile.profilePic);
        if (off.officialPosts.length) for (const p of (profile.posts || []).slice(0, 12)) p.thumbHash = await hashImage(p.thumb);
        const result = D.scoreSocial(profile, brand, { logoHashes: off.logoHashes, officialPosts: off.officialPosts });
        results.push({ handle: h, ok: true, profile: slimProfile(profile), result, cached, stale, warning, cachedAt });
        trackFinding('ig:' + h, result);
      } catch (e) {
        results.push({ handle: h, ok: false, error: e.message, code: e.code });
      }
    }
    setBusy({ kind: 'instagram', done: total, total, label: 'Saving results…' });
    const high = results.filter((r) => r.ok && r.result.severity === 'High').length;
    const failed = results.filter((r) => !r.ok).length;
    const partial = failed > 0 || off.status.some((s) => !s.ok) || results.some((r) => r.stale);
    S.scans.instagram = { at: Date.now(), results, official: off.status, partial, logoCount: off.logoHashes.length, officialPostCount: off.officialPosts.length };
    logActivity(`Instagram scan: ${results.length} accounts, ${high} high risk${failed ? `, ${failed} unavailable` : ''}`, high ? 'high' : 'info');
    await Promise.all([api('/api/scans/instagram', { method: 'PUT', body: S.scans.instagram }), saveFindings()]);
    toast(`Instagram scan done: ${high} high-risk account${high === 1 ? '' : 's'}${partial ? ' · partial results' : ''}.`, partial ? 'err' : '');
  } catch (e) {
    toast('Scan failed: ' + e.message, 'err');
  } finally { setBusy(null); chrome(); rerender(); }
}

function slimProfile(p) {
  return { ...p, posts: (p.posts || []).slice(0, 12).map(({ thumbHash, ...x }) => x) };
}

function trackFinding(key, result) {
  const f = finding(key);
  f.lastSeen = Date.now(); f.lastScore = result.score; f.lastSeverity = result.severity;
  if (!f.history.length) f.history.push({ at: Date.now(), text: result.excluded ? 'First seen: official / excluded' : `First seen: score ${result.score} (${result.severity})` });
  else if (f.prevScore != null && f.prevScore !== result.score && !result.excluded) f.history.push({ at: Date.now(), text: `Score changed ${f.prevScore} → ${result.score}` });
  f.prevScore = result.score;
}

/** Check whether variant usernames exist on Instagram (proactive search). */
export async function probeHandles(handles) {
  if (S.busy) { toast('A scan is already running.'); return []; }
  const out = [];
  setBusy({ kind: 'probe', done: 0, total: handles.length, label: 'Searching Instagram for look-alike names…' });
  for (const [i, h] of handles.entries()) {
    setBusy({ kind: 'probe', done: i, total: handles.length, label: 'Looking up @' + h });
    try { const { profile } = await fetchProfile(h); out.push({ handle: h, exists: true, profile }); }
    catch (e) { out.push({ handle: h, exists: false, error: e.code === 'not_found' ? 'Not taken' : e.message, code: e.code }); if (e.code === 'rate_limited' || e.code === 'login_required') { toast(e.message, 'err'); break; } }
  }
  setBusy(null);
  const found = out.filter((x) => x.exists).length;
  logActivity(`Variant search: ${found} of ${out.length} look-alike usernames exist`, found ? 'high' : 'info');
  await saveFindings();
  return out;
}

/* ---------------- App Store scan ---------------- */

export async function scanAppStore() {
  if (S.busy) return toast('A scan is already running.');
  if (!brandReady()) { toast('Set up the brand profile first.', 'err'); location.hash = '#/brand'; return; }
  const country = S.brand.country || 'in';
  const terms = (S.watchlist.appTerms?.length ? S.watchlist.appTerms : [S.brand.name, ...(S.brand.aliases || [])]).filter(Boolean);
  const apps = S.brand.apps || [];
  const total = terms.length + 1;
  setBusy({ kind: 'appstore', done: 0, total, label: 'Looking up official apps…' });
  try {
    // 1. official apps
    let officialApps = [];
    const warnings = [];
    const ids = apps.map((a) => a.trackId).filter(Boolean); const bids = apps.map((a) => a.bundleId).filter(Boolean);
    try {
      if (ids.length) officialApps.push(...(await api(`/api/appstore/lookup?country=${country}&id=${ids.join(',')}`)).results);
      if (bids.length) officialApps.push(...(await api(`/api/appstore/lookup?country=${country}&bundleId=${bids.join(',')}`)).results);
    } catch (e) { warnings.push('Official app lookup failed: ' + e.message); }
    officialApps = dedupe(officialApps, (a) => a.trackId).filter((o) => ids.includes(o.trackId) || bids.map((b) => b.toLowerCase()).includes(o.bundleId.toLowerCase()));
    const logoHashes = [];
    if (S.brand.logoHash) logoHashes.push({ label: 'your logo', hash: S.brand.logoHash });
    for (const o of officialApps) { const h = await hashImage(o.icon); if (h) logoHashes.push({ label: `the official "${o.name}" icon`, hash: h }); }
    const brand = D.compileBrand(S.brand, { officialApps, developerIds: officialApps.map((o) => o.artistId) });
    // 2. search
    let found = [];
    for (const [i, t] of terms.entries()) {
      setBusy({ kind: 'appstore', done: i + 1, total, label: `Searching the App Store for "${t}"` });
      try { const r = await api(`/api/appstore/search?country=${country}&term=${encodeURIComponent(t)}`); found.push(...r.results); if (r.stale) warnings.push(`"${t}": showing cached results (${r.warning})`); }
      catch (e) { warnings.push(`"${t}": ${e.message}`); }
    }
    found = dedupe(found, (a) => a.trackId);
    // 3. score
    const results = []; let unrelated = 0;
    for (const a of found) {
      a.iconHash = await hashImage(a.icon);
      const result = D.scoreApp(a, brand, { logoHashes });
      if (!result.excluded && !result.related) { unrelated++; continue; }
      results.push({ app: a, result });
      trackFinding('app:' + a.trackId, result);
    }
    results.sort((x, y) => (x.result.excluded - y.result.excluded) || y.result.score - x.result.score);
    const high = results.filter((r) => r.result.severity === 'High').length;
    S.scans.appstore = { at: Date.now(), country, terms, results, unrelated, officialApps, warnings, partial: warnings.length > 0 };
    logActivity(`App Store scan: ${results.length} related apps, ${high} high risk`, high ? 'high' : 'info');
    await Promise.all([api('/api/scans/appstore', { method: 'PUT', body: S.scans.appstore }), saveFindings()]);
    toast(`App Store scan done: ${high} high-risk app${high === 1 ? '' : 's'}${warnings.length ? ' · partial results' : ''}.`, warnings.length ? 'err' : '');
  } catch (e) {
    toast('Scan failed: ' + e.message, 'err');
  } finally { setBusy(null); chrome(); rerender(); }
}

const dedupe = (arr, key) => { const m = new Map(); for (const x of arr) if (!m.has(key(x))) m.set(key(x), x); return [...m.values()]; };

/* ---------------- shell: theme, sidebar, badges ---------------- */

const THEMES = { black: 'Black', navy: 'Navy', light: 'Light' };
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }

function applyTheme(t) {
  if (!THEMES[t]) t = 'black';
  const app = $('#app');
  app.classList.remove('theme-black', 'theme-navy', 'theme-light'); app.classList.add('theme-' + t);
  document.body.style.background = t === 'light' ? '#e9e9ec' : t === 'navy' ? '#060a14' : '#060606';
  $('#themeLabel').textContent = 'Theme: ' + THEMES[t];
  $('#themeSw').className = 'sw sw-' + t;
  $$('#themeMenu .mi').forEach((b) => { const on = b.dataset.theme === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  store('fl-theme', t);
}
function closeMenu() { $('#themeMenu')?.classList.add('hidden'); $('#themeBtn')?.setAttribute('aria-expanded', 'false'); }

export function openFindings(kind) {
  const scan = kind === 'ig' ? S.scans.instagram : S.scans.appstore;
  if (!scan) return 0;
  return scan.results.filter((r) => (kind === 'ig' ? r.ok : true) && !r.result.excluded && r.result.severity !== 'Low' && !['Resolved', 'False positive'].includes(S.findings.items[(kind === 'ig' ? 'ig:' + r.handle : 'app:' + r.app.trackId)]?.status)).length;
}

export function chrome() {
  const b = S.brand;
  $('#brandNameSide').textContent = b.name || 'No brand yet';
  $('#brandInitials').textContent = (b.name || 'FL').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  $('#welcomeHello').textContent = b.name ? `Protecting ${b.name}` : 'Welcome to FraudLens';
  const last = Math.max(S.scans.instagram?.at || 0, S.scans.appstore?.at || 0);
  $('#welcomeSub').textContent = last ? 'Last scan: ' + new Date(last).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'No scans yet';
  const ig = openFindings('ig'), ap = openFindings('app');
  $('#badgeSocial').textContent = ig || '';
  $('#badgeApps').textContent = ap || '';
  const v = D.validateBrand({ ...b, instagramLines: b.instagram, appLines: [] });
  $('#badgeBrand').textContent = brandReady() ? '' : '!';
  $('#modeName').textContent = S.config.demo ? 'Demo data' : 'Live';
  $('#modeDesc').textContent = S.config.demo ? 'Bundled sample accounts and apps, no network.' : S.config.graphConfigured && S.config.igMode !== 'web' ? 'Instagram Graph API + Apple App Store' : 'Instagram public profiles + Apple App Store';
  void v;
}

/* ---------------- routing ---------------- */

const ROUTES = {
  dashboard: ['Dashboard', 'Overview', 'Brand impersonation across Instagram and the Apple App Store.'],
  social: ['Social monitoring', 'Monitoring / Instagram', 'Score Instagram accounts against your brand profile with checks S1–S10.'],
  apps: ['App store monitoring', 'Monitoring / Apple App Store', 'Find apps that copy your name, icon, developer or description (checks A1–A9).'],
  variants: ['Name variants', 'Monitoring / Name variants', 'Generate the usernames an impersonator would pick, then check which exist.'],
  brand: ['Brand profile', 'Monitoring / Brand profile', 'The official registry every check compares against. Official assets are never flagged.'],
  sources: ['Monitoring sources', 'Others / Sources', 'How FraudLens reaches Instagram and the App Store, and what to do when a source is unavailable.']
};

export function rerender() {
  const [title, crumb, sub] = ROUTES[S.route];
  $('#pageTitle').textContent = title; $('#crumb').textContent = crumb; $('#pageSub').textContent = sub;
  $$('.sitem').forEach((a) => { const on = a.dataset.route === S.route; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  renderView(S.route);
  renderProgress();
}

function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  S.route = ROUTES[r] ? r : 'dashboard';
  closeModal(); rerender();
  window.scrollTo({ top: 0 });
}

/* ---------------- boot ---------------- */

async function boot() {
  const app = $('#app');
  app.appendChild($('#toasts')); app.appendChild($('#modalRoot'));
  applyTheme(store('fl-theme') || 'black');
  if (store('fl-collapsed') === '1') app.classList.add('collapsed');
  $('#collapseBtn').addEventListener('click', () => {
    const c = app.classList.toggle('collapsed'); store('fl-collapsed', c ? '1' : '0');
    $('#collapseBtn').setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
  });
  $('#themeBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#themeMenu'); const open = m.classList.toggle('hidden') === false; $('#themeBtn').setAttribute('aria-expanded', open); if (open) $('#themeMenu .mi.on')?.focus(); });
  $$('#themeMenu .mi').forEach((b) => b.addEventListener('click', () => { applyTheme(b.dataset.theme); closeMenu(); $('#themeBtn').focus(); }));
  document.addEventListener('click', (e) => { if (!e.target.closest('.dd')) closeMenu(); });
  try { await loadState(); }
  catch (e) { $('#view').innerHTML = `<div class="empty"><strong>Can't reach the FraudLens server</strong>Start it with <span class="code">node server.js</span> and reload. (${esc(e.message)})</div>`; return; }
  chrome();
  window.addEventListener('hashchange', route);
  route();
}
boot();
