// FraudLens: apply all changes in one go.
//
// How to use (in VS Code: open the FraudLens folder, open a terminal with Ctrl+`):
//   1. Save this file in the project folder, next to server.js.
//   2. Run:  node apply-changes.js
//   3. Restart the server (Ctrl+C, then node server.js) and hard-refresh the page (Ctrl+F5).
//
// What it changes (each original file is first copied to <name>.bak; running it again is safe):
//   Scoring    public/js/detect.js   a close name match on a new account with under 500 followers
//                                    is raised to 50 (Medium), so limited data can't leave it at Low.
//   Auto-scan  public/js/autoscan.js NEW: timer + sidebar control. public/js/app.js gets a live-data option.
//   Brands     public/js/brands.js   NEW: "Manage brands (n/3)" sidebar panel (switch, add, remove).
//              server.js             each brand gets its own folder in data/brands/. Your current
//                                    brand becomes brand 1 automatically (old files stay in data/).
//              public/js/app.js, public/js/views.js   small hooks for the above.
//   public/index.html loads the two new scripts.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const AUTOSCAN = "// FraudLens auto-scan. Re-runs the Instagram watchlist scan and the App Store scan on a timer,\n// from whichever page is open, so the brand is checked repeatedly without pressing the scan buttons.\n// Pick the interval in the sidebar. It is off until you choose one, and it only runs while this tab is open.\nimport { S, scanInstagram, scanAppStore, brandReady } from './app.js';\n\nconst KEY = 'fl-autoscan-minutes';\nconst CHOICES = [0, 1, 5, 15, 30, 60]; // minutes; 0 = off. 1 and 5 are meant for demos.\nconst FRESH_FROM = 15; // from this interval up, Instagram is read live instead of from the server's 6-hour cache\n\nlet minutes = 0;\nlet nextAt = 0;\nlet lastAt = 0;\nlet running = false;\ntry { minutes = Number(localStorage.getItem(KEY)) || 0; } catch { /* storage blocked: stay off */ }\nif (!CHOICES.includes(minutes)) minutes = 0;\n\nconst foot = document.querySelector('.sfoot');\nif (foot) {\n  /* ---------- sidebar card (uses the app's own .update card and .status-sel select styles) ---------- */\n  const card = document.createElement('div');\n  card.className = 'update';\n  card.id = 'autoScan';\n  card.append('Auto-scan');\n  const state = document.createElement('strong');\n  const select = document.createElement('select');\n  select.className = 'status-sel';\n  select.setAttribute('aria-label', 'Auto-scan interval');\n  for (const m of CHOICES) {\n    const o = document.createElement('option');\n    o.value = String(m);\n    o.textContent = m === 0 ? 'Off' : m === 60 ? 'Every hour' : m === 1 ? 'Every minute (demo)' : m === 5 ? 'Every 5 minutes (demo)' : 'Every ' + m + ' minutes';\n    if (m === minutes) o.selected = true;\n    select.appendChild(o);\n  }\n  const note = document.createElement('span');\n  note.style.display = 'block';\n  note.style.marginTop = '6px';\n  note.setAttribute('aria-live', 'polite');\n  card.append(state, select, note);\n  foot.insertBefore(card, document.getElementById('modeCard'));\n\n  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });\n  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };\n\n  function render(msg) {\n    if (!minutes) { state.textContent = 'Off'; note.textContent = 'Scans only when you press a scan button.'; return; }\n    state.textContent = running || S.busy ? 'Scanning\u2026' : msg || 'Next scan in ' + mmss(nextAt - Date.now());\n    note.textContent = (lastAt ? 'Last auto-scan ' + clock(lastAt) + '. ' : '') + (minutes >= FRESH_FROM ? 'Reads Instagram live each time.' : 'Reuses cached Instagram data. Use 15 minutes or more for live checks.');\n  }\n\n  // Do not re-render the page underneath someone who is typing in a form.\n  const userIsTyping = () => {\n    const a = document.activeElement;\n    return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.closest?.('#view');\n  };\n\n  async function tick() {\n    if (!minutes) return render();\n    if (!nextAt) nextAt = Date.now() + minutes * 60000;\n    if (Date.now() < nextAt || running) return render();\n    if (S.busy) return render('Waiting for the current scan to finish');\n    if (!brandReady()) return render('Paused: set up the brand profile first');\n    if (userIsTyping()) return render('Waiting: you are editing a field');\n    running = true;\n    render();\n    try {\n      if ((S.watchlist?.instagram || []).length) await scanInstagram({ fresh: minutes >= FRESH_FROM });\n      if (!S.busy) await scanAppStore();\n    } catch { /* each scan reports its own errors with a toast */ }\n    finally {\n      running = false;\n      lastAt = Date.now();\n      nextAt = lastAt + minutes * 60000;\n      render();\n    }\n  }\n\n  select.addEventListener('change', () => {\n    minutes = Number(select.value);\n    try { localStorage.setItem(KEY, String(minutes)); } catch { /* ignore */ }\n    nextAt = minutes ? Date.now() + minutes * 60000 : 0;\n    render();\n  });\n\n  render();\n  setInterval(tick, 1000);\n}\n";
const BRANDS_JS = "// FraudLens brands: manage up to 3 brand profiles. Each brand keeps its own profile, watchlist,\n// findings and scan history. A sidebar panel switches between brands, adds one, or removes one.\nimport { S, api, toast, loadState, chrome, rerender } from './app.js';\nimport { resetBrandViews } from './views.js';\n\nconst MAX = 3;\nconst KEY = 'fl-brands-open';\nlet open = true;\ntry { open = localStorage.getItem(KEY) !== '0'; } catch { /* storage blocked: stay open */ }\n\nconst anchor = document.querySelector('.sitem[data-route=\"brand\"]');\nif (anchor) {\n  const style = document.createElement('style');\n  style.textContent = `\n    .brands { margin: 8px 0 6px; padding: 6px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface2); }\n    .brands-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 8px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; text-align: left; cursor: pointer; border-radius: 10px; }\n    .brands-head:hover { color: var(--text); }\n    .brands-head i { font-style: normal; font-size: 10px; transition: transform .15s; }\n    .brands-head[aria-expanded=\"false\"] i { transform: rotate(-90deg); }\n    .brand-row { display: flex; align-items: center; gap: 2px; border: 1px solid transparent; border-radius: 12px; }\n    .brand-row.on { background: var(--raise); border-color: var(--glass-line); }\n    .brand-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 8px; border: 0; border-radius: 12px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }\n    .brand-main:hover { background: var(--glass); }\n    .brand-main .bi { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 8px; background: linear-gradient(140deg, var(--accent2), var(--accent)); color: var(--ink); font-size: 12px; font-weight: 700; }\n    .brand-main .bn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n    .brand-main .bs { font-size: 11px; color: var(--accent-text); }\n    .brand-more { width: 32px; height: 32px; flex: none; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }\n    .brand-more:hover { background: var(--glass); color: var(--text); }\n    .brand-actions { display: flex; padding: 2px 8px 6px 44px; }\n    .brand-rm { border: 0; background: transparent; color: var(--neg); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 0; }\n    .brand-rm:disabled { color: var(--faint); cursor: not-allowed; }\n    .brand-add { width: 100%; min-height: 40px; margin-top: 6px; border: 1px dashed var(--accent-text); border-radius: 12px; background: transparent; color: var(--accent-text); font: inherit; font-size: 13px; cursor: pointer; }\n    .brand-add:hover:not(:disabled) { background: var(--mark); }\n    .brand-add:disabled { opacity: .5; cursor: not-allowed; }\n    .collapsed .brands { display: none; }\n    @media (max-width: 820px) { .brands { display: none; } }\n  `;\n  document.head.appendChild(style);\n\n  const panel = document.createElement('div');\n  panel.className = 'brands';\n  panel.id = 'brandsPanel';\n  anchor.after(panel);\n\n  const el = (tag, cls, text) => {\n    const e = document.createElement(tag);\n    if (cls) e.className = cls;\n    if (text != null) e.textContent = text;\n    if (tag === 'button') e.type = 'button';\n    return e;\n  };\n\n  /** After any brand change: drop the old brand's form drafts, reload the new brand's data, redraw. */\n  async function reload(goTo) {\n    resetBrandViews();\n    await loadState();\n    chrome();\n    if (goTo && location.hash !== goTo) location.hash = goTo; // route() redraws on a hash change\n    rerender();\n  }\n  const guard = () => { if (S.busy) { toast('Wait for the current scan to finish first.', 'err'); return false; } return true; };\n\n  async function switchTo(b) {\n    if (b.active || !guard()) return;\n    try {\n      await api('/api/brands/switch', { method: 'POST', body: { id: b.id } });\n      await reload();\n      toast('Switched to ' + (S.brand.name || 'the new brand') + '.');\n    } catch (e) { toast(e.message, 'err'); }\n  }\n\n  async function addBrand() {\n    if (!guard()) return;\n    if ((S.brands || []).length >= MAX) return toast(`You can manage up to ${MAX} brands. Remove one to add another.`, 'err');\n    try {\n      await api('/api/brands', { method: 'POST' });\n      await reload('#/brand');\n      toast('New brand added. Fill in its profile, then save it.');\n    } catch (e) { toast(e.message, 'err'); }\n  }\n\n  async function removeBrand(b) {\n    if (!guard()) return;\n    const label = b.name || 'this brand';\n    if (!window.confirm(`Remove ${label}? Its profile, watchlist, findings and scan history will be deleted. This cannot be undone.`)) return;\n    try {\n      await api('/api/brands/' + encodeURIComponent(b.id), { method: 'DELETE' });\n      await reload();\n      toast(`Removed ${label}.`);\n    } catch (e) { toast(e.message, 'err'); }\n  }\n\n  function render() {\n    // The active brand's name comes from the live profile, so it updates as soon as you save.\n    const brands = (S.brands || []).map((b) => ({ ...b, name: b.active ? (S.brand?.name || '') : b.name }));\n    panel.replaceChildren();\n\n    const head = el('button', 'brands-head');\n    head.setAttribute('aria-expanded', String(open));\n    head.append(el('i', '', '\u25be'), `Manage brands (${brands.length}/${MAX})`);\n    head.addEventListener('click', () => {\n      open = !open;\n      try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* ignore */ }\n      render();\n    });\n    panel.appendChild(head);\n    if (!open) return;\n\n    for (const b of brands) {\n      const wrap = el('div');\n      const row = el('div', 'brand-row' + (b.active ? ' on' : ''));\n      const main = el('button', 'brand-main');\n      main.title = b.active ? 'Active brand' : 'Switch to ' + (b.name || 'this brand');\n      main.append(el('span', 'bi', (b.name || 'N')[0].toUpperCase()), el('span', 'bn', b.name || 'New brand'));\n      if (b.active) main.append(el('span', 'bs', 'Active'));\n      main.addEventListener('click', () => switchTo(b));\n\n      const more = el('button', 'brand-more', '\u22ef');\n      more.setAttribute('aria-label', 'Options for ' + (b.name || 'new brand'));\n      more.setAttribute('aria-expanded', 'false');\n      const actions = el('div', 'brand-actions hidden');\n      const rm = el('button', 'brand-rm', 'Remove brand');\n      rm.disabled = brands.length <= 1;\n      if (rm.disabled) rm.title = 'Keep at least one brand';\n      rm.addEventListener('click', () => removeBrand(b));\n      actions.appendChild(rm);\n      more.addEventListener('click', () => {\n        actions.classList.toggle('hidden');\n        more.setAttribute('aria-expanded', String(!actions.classList.contains('hidden')));\n      });\n\n      row.append(main, more);\n      wrap.append(row, actions);\n      panel.appendChild(wrap);\n    }\n\n    const add = el('button', 'brand-add', '+ Add brand');\n    add.disabled = brands.length >= MAX;\n    if (add.disabled) add.title = `Up to ${MAX} brands. Remove one to add another.`;\n    add.addEventListener('click', addBrand);\n    panel.appendChild(add);\n  }\n\n  document.addEventListener('fl:chrome', render); // app.js fires this whenever the sidebar refreshes\n  render();\n}\n";
const SERVER_BLOCK = "/* ---------------- brands: up to 3 workspaces, each with its own profile, watchlist, findings and scans ---------------- */\n\nconst MAX_BRANDS = 3;\nconst BRAND_IDS = ['b1', 'b2', 'b3'];\nconst BRAND_FILES = new Set(['brand.json', 'watchlist.json', 'findings.json', 'scans.json']);\nlet brandsIndex = null; // { active: 'b1', items: [{ id: 'b1' }] }\nlet brandsReady;\n\nconst brandDir = (id) => path.join(DATA, 'brands', id);\n// Brand files live in the active brand's folder. Settings (config.json) and the cache are shared by all brands.\nfunction dataPath(name) {\n  return BRAND_FILES.has(name) && brandsIndex ? path.join(brandDir(brandsIndex.active), name) : path.join(DATA, name);\n}\nasync function saveBrandsIndex() {\n  const file = path.join(DATA, 'brands.json');\n  await fs.writeFile(file + '.tmp', JSON.stringify(brandsIndex, null, 2));\n  await fs.rename(file + '.tmp', file);\n}\nfunction initBrands() {\n  return (brandsReady ||= (async () => {\n    try { brandsIndex = JSON.parse(await fs.readFile(path.join(DATA, 'brands.json'), 'utf8')); } catch { brandsIndex = null; }\n    if (!Array.isArray(brandsIndex?.items) || !brandsIndex.items.length) {\n      // First run with brands: copy the existing single brand in as the first one (the old files stay in data/ untouched).\n      await fs.mkdir(brandDir('b1'), { recursive: true });\n      for (const n of BRAND_FILES) await fs.copyFile(path.join(DATA, n), path.join(brandDir('b1'), n)).catch(() => {});\n      brandsIndex = { active: 'b1', items: [{ id: 'b1' }] };\n      await saveBrandsIndex();\n    }\n    if (!brandsIndex.items.some((b) => b.id === brandsIndex.active)) { brandsIndex.active = brandsIndex.items[0].id; await saveBrandsIndex(); }\n    for (const b of brandsIndex.items) await fs.mkdir(brandDir(b.id), { recursive: true });\n  })());\n}\nasync function listBrands() {\n  const out = [];\n  for (const b of brandsIndex.items) {\n    let name = '';\n    try { name = String(JSON.parse(await fs.readFile(path.join(brandDir(b.id), 'brand.json'), 'utf8')).name || '').trim(); } catch { /* new brand: no profile yet */ }\n    out.push({ id: b.id, name, active: b.id === brandsIndex.active });\n  }\n  return out;\n}\n\n";
const SERVER_ROUTES = "    // A tab that still shows another brand must not write into the brand that is active now.\n    const tabBrand = req.headers['x-brand-id'];\n    if (tabBrand && brandsIndex && req.method !== 'GET' && /^\\/api\\/(brand|watchlist|findings|scans\\/[a-z]+|demo\\/reset)$/.test(p) && tabBrand !== brandsIndex.active) {\n      return send(res, 409, { error: 'The active brand was changed in another tab. Reload this page to continue.', code: 'brand_changed' });\n    }\n    if (p === '/api/brands' && req.method === 'POST') { // add a brand and make it the active one\n      if (brandsIndex.items.length >= MAX_BRANDS) return send(res, 400, { error: `You can manage up to ${MAX_BRANDS} brands. Remove one to add another.`, code: 'brand_limit' });\n      const id = BRAND_IDS.find((x) => !brandsIndex.items.some((b) => b.id === x));\n      await fs.mkdir(brandDir(id), { recursive: true });\n      brandsIndex.items.push({ id }); brandsIndex.active = id; await saveBrandsIndex();\n      return send(res, 200, { ok: true, brands: await listBrands() });\n    }\n    if (p === '/api/brands/switch' && req.method === 'POST') {\n      const b = await body(req);\n      if (!brandsIndex.items.some((x) => x.id === b.id)) return send(res, 404, { error: 'Brand not found.', code: 'not_found' });\n      brandsIndex.active = b.id; await saveBrandsIndex();\n      return send(res, 200, { ok: true, brands: await listBrands() });\n    }\n    if (p.startsWith('/api/brands/') && req.method === 'DELETE') {\n      const id = decodeURIComponent(p.split('/').pop());\n      if (!brandsIndex.items.some((x) => x.id === id)) return send(res, 404, { error: 'Brand not found.', code: 'not_found' });\n      if (brandsIndex.items.length <= 1) return send(res, 400, { error: 'Keep at least one brand. Add another first, or edit this one.', code: 'last_brand' });\n      brandsIndex.items = brandsIndex.items.filter((x) => x.id !== id);\n      if (brandsIndex.active === id) brandsIndex.active = brandsIndex.items[0].id;\n      await saveBrandsIndex();\n      await fs.rm(brandDir(id), { recursive: true, force: true });\n      return send(res, 200, { ok: true, brands: await listBrands() });\n    }\n    \n";
let failed = false;

const rel = (p) => path.join(ROOT, ...p.split('/'));
const say = (s) => console.log(s);

function backup(file) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

/** Apply exact-text edits to one file. Each edit: { name, find, replace, skipIf }. All or nothing per file. */
function patch(p, edits) {
  const file = rel(p);
  if (!fs.existsSync(file)) { say(`FAIL  ${p}: file not found. Run this from the folder that contains server.js.`); failed = true; return; }
  let text = fs.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  if (crlf) text = text.replace(/\r\n/g, '\n'); // match on plain \n, write back in the file's own style
  let changed = false;
  for (const e of edits) {
    if (e.skipIf && text.includes(e.skipIf)) { say(`skip  ${p}: ${e.name} (already applied)`); continue; }
    const n = text.split(e.find).length - 1;
    if (n !== 1) { say(`FAIL  ${p}: ${e.name}: expected to find the original text once, found ${n}. Nothing was changed in this file.`); failed = true; return; }
    text = text.replace(e.find, () => e.replace);
    changed = true;
    say(`ok    ${p}: ${e.name}`);
  }
  if (changed) { backup(file); fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text); }
}

/** Write a new file (or update it if the content changed). */
function writeNew(p, content) {
  const file = rel(p);
  if (!fs.existsSync(path.dirname(file))) { say(`FAIL  ${p}: folder not found. Run this from the folder that contains server.js.`); failed = true; return; }
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) { say(`skip  ${p} (already up to date)`); return; }
  if (fs.existsSync(file)) backup(file);
  fs.writeFileSync(file, content);
  say(`ok    ${p} written`);
}

/** Make sure index.html loads a script as a module. Replaces an older plain tag if you added one earlier. */
function ensureTag(src) {
  const p = 'public/index.html';
  const file = rel(p);
  if (!fs.existsSync(file)) { say(`FAIL  ${p}: file not found.`); failed = true; return; }
  let text = fs.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  if (crlf) text = text.replace(/\r\n/g, '\n');
  const tag = `<script type="module" src="${src}"></script>`;
  const esc = src.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const old = new RegExp(`<script(?![^>]*type="module")[^>]*src="${esc}"[^>]*></script>`);
  let out = null;
  if (text.includes(tag)) { say(`skip  ${p}: ${src} tag (already applied)`); return; }
  if (old.test(text)) out = text.replace(old, () => tag);
  else {
    const anchor = '<script type="module" src="/js/app.js"></script>';
    if (text.split(anchor).length - 1 !== 1) { say(`FAIL  ${p}: could not find the app.js script tag. Add this line before </body> yourself:  ${tag}`); failed = true; return; }
    out = text.replace(anchor, () => anchor + '\n' + tag);
  }
  backup(file);
  fs.writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
  say(`ok    ${p}: ${src} tag added`);
}

/* 1. Scoring fix */
patch('public/js/detect.js', [
  {
    name: 'finalise() accepts floor50',
    find: '{ cap74, floor75, notes = [] }',
    replace: '{ cap74, floor75, floor50, notes = [] }',
    skipIf: '{ cap74, floor75, floor50, notes = [] }'
  },
  {
    name: 'guardrail 5 (raise to 50)',
    find: "guardrails.push('Raised to 75: look-alike name plus two strong signals (guardrail 3).'); }",
    replace: "guardrails.push('Raised to 75: look-alike name plus two strong signals (guardrail 3).'); }\n  if (floor50 && score < 50) { score = 50; guardrails.push('Raised to 50: look-alike name on a new, tiny account. Limited data hides the other checks (guardrail 5).'); }",
    skipIf: 'Raised to 50'
  },
  {
    name: 'scoreSocial() passes floor50',
    find: 'const res = finalise(checks, { cap74: !supporting, floor75: (s1 >= 20 || nm.s2 > 0) && strong >= 2, notes });',
    replace: 'const newAndTiny = s3 > 0 && profile.followers != null && profile.followers < 500;\n  const floor50 = (s1 >= 20 || nm.s2 > 0) && newAndTiny && (!disclaimer || s5 > 0);\n  const res = finalise(checks, { cap74: !supporting, floor75: (s1 >= 20 || nm.s2 > 0) && strong >= 2, floor50, notes });',
    skipIf: 'const floor50 ='
  }
]);

/* 2. app.js: live-data option for scans (auto-scan) + brand hooks */
patch('public/js/app.js', [
  { name: 'officialContext() takes fresh', find: 'async function officialContext(onStep) {', replace: 'async function officialContext(onStep, fresh = false) {', skipIf: 'async function officialContext(onStep, fresh = false) {' },
  { name: 'official accounts honour fresh', find: 'const { profile, cached, stale } = await fetchProfile(h);', replace: 'const { profile, cached, stale } = await fetchProfile(h, fresh);', skipIf: 'const { profile, cached, stale } = await fetchProfile(h, fresh);' },
  { name: 'scanInstagram() takes fresh', find: 'export async function scanInstagram({ handles } = {}) {', replace: 'export async function scanInstagram({ handles, fresh = false } = {}) {', skipIf: 'export async function scanInstagram({ handles, fresh = false } = {}) {' },
  { name: 'official context call passes fresh', find: "const off = await officialContext((label) => { setBusy({ kind: 'instagram', done: done++, total, label }); });", replace: "const off = await officialContext((label) => { setBusy({ kind: 'instagram', done: done++, total, label }); }, fresh);", skipIf: 'label }); }, fresh);' },
  { name: 'watchlist accounts honour fresh', find: 'const { profile, cached, stale, warning, cachedAt } = await fetchProfile(h);', replace: 'const { profile, cached, stale, warning, cachedAt } = await fetchProfile(h, fresh);', skipIf: 'const { profile, cached, stale, warning, cachedAt } = await fetchProfile(h, fresh);' },
  { name: 'state holds the brand list', find: 'busy: null, // { kind, done, total, label }', replace: 'busy: null, // { kind, done, total, label }\n  brands: [], // [{ id, name, active }], up to 3\n  brandId: \'\',', skipIf: 'brandId: \'\',' },
  { name: 'requests say which brand they belong to', find: "const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });", replace: "const res = await fetch(path, { headers: { 'content-type': 'application/json', ...(S.brandId ? { 'x-brand-id': S.brandId } : {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });", skipIf: "'x-brand-id': S.brandId" },
  { name: 'loadState() reads the brand list', find: 'scans: st.scans, config: st.config });', replace: "scans: st.scans, config: st.config, brands: st.brands || [], brandId: (st.brands || []).find((b) => b.active)?.id || '' });", skipIf: 'brands: st.brands || []' },
  { name: 'chrome() tells the brand panel to redraw', find: 'void v;', replace: "void v;\n  document.dispatchEvent(new Event('fl:chrome'));", skipIf: "new Event('fl:chrome')" }
]);

/* 3. views.js: forget the previous brand's form drafts when switching */
patch('public/js/views.js', [
  { name: 'resetBrandViews() added', find: 'let draft = null;', replace: "let draft = null;\nexport function resetBrandViews() { draft = null; probe = { results: {}, base: '' }; socialFilter = 'All'; }", skipIf: 'export function resetBrandViews' }
]);

/* 4. server.js: one folder of data per brand */
patch('server.js', [
  { name: 'reads use the active brand folder', find: "await fs.readFile(path.join(DATA, name), 'utf8')", replace: "await fs.readFile(dataPath(name), 'utf8')", skipIf: "await fs.readFile(dataPath(name), 'utf8')" },
  { name: 'writes use the active brand folder', find: 'const file = path.join(DATA, name);', replace: 'const file = dataPath(name);', skipIf: 'const file = dataPath(name);' },
  { name: 'brand storage added', find: '/* ---------------- Instagram ---------------- */', replace: SERVER_BLOCK + '/* ---------------- Instagram ---------------- */', skipIf: 'const MAX_BRANDS = 3;' },
  { name: 'state includes the brand list', find: 'return send(res, 200, { brand, watchlist, findings, scans, config: publicConfig(config) });', replace: 'return send(res, 200, { brand, watchlist, findings, scans, config: publicConfig(config), brands: await listBrands() });', skipIf: 'brands: await listBrands()' },
  { name: 'brand routes added', find: "if (p === '/api/state' && req.method === 'GET') {", replace: SERVER_ROUTES.replace(/\s+$/, '').replace(/^\s+/, '') + "\n    if (p === '/api/state' && req.method === 'GET') {", skipIf: "p === '/api/brands'" },
  { name: 'brands load at startup', find: 'return ready;', replace: 'return ready.then(() => initBrands());', skipIf: 'initBrands());' }
]);

/* 5. New files and script tags */
writeNew('public/js/autoscan.js', AUTOSCAN);
writeNew('public/js/brands.js', BRANDS_JS);
ensureTag('/js/autoscan.js');
ensureTag('/js/brands.js');

say(failed ? '\nFinished with problems (see FAIL lines above). Files with a FAIL were left unchanged.' : '\nDone. Restart the server (Ctrl+C, then node server.js) and hard-refresh the page (Ctrl+F5).');
process.exit(failed ? 1 : 0);
