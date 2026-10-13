// FraudLens MVP — page views. Every piece of text from Instagram or the App Store goes through esc().
import * as D from './detect.js';
import {
  S, esc, $, $$, fmt, ago, sevClass, imgSrc, safeUrl, api, toast, download, openModal, closeModal,
  scanInstagram, scanAppStore, probeHandles, setStatus, saveBrand, saveWatchlist, saveFindings, logActivity,
  hashImage, shrinkImage, brandReady, chrome, rerender, loadState, finding
} from './app.js';

const STATUSES = ['New', 'Under review', 'Resolved', 'False positive'];
const SEG = ['s1', 's2', 's3', 's4', 's5', 's1', 's3', 's5', 's2', 's4'];
const ICON = {
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>'
};

const progressEl = '<div id="progress" class="progress hidden" role="status"></div>';
const headerActions = (html) => { $('#headerActions').innerHTML = html; };
const pill = (sev) => `<span class="pill ${sevClass(sev)}">${esc(sev)}</span>`;
const vbadge = (on) => (on ? '<span class="vbadge" title="Verified badge" aria-label="verified">✓</span>' : '');

function sbar(result) {
  if (!result || result.excluded) return '';
  const pos = result.checks.filter((c) => c.points > 0);
  const total = pos.reduce((s, c) => s + c.points, 0) || 1;
  return `<div class="sbar" aria-hidden="true">${pos.map((c, i) => `<div class="${SEG[result.checks.indexOf(c) % SEG.length]}" style="width:${(100 * c.points / total).toFixed(1)}%" title="${esc(c.label)}: ${c.points}"></div>`).join('')}</div>`;
}
function riskCell(result) {
  if (result.excluded) return `<span class="pill in">${esc(result.severity)}</span>`;
  return `<strong>${result.score}</strong> ${pill(result.severity)}${sbar(result)}`;
}
function statusSelect(key) {
  const st = S.findings.items[key]?.status || 'New';
  return `<select class="status-sel" data-status="${esc(key)}" aria-label="Status">${STATUSES.map((s) => `<option${s === st ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
}
function bindStatus(root) {
  $$('[data-status]', root).forEach((sel) => sel.addEventListener('change', async () => { await setStatus(sel.dataset.status, sel.value); rerender(); }));
}
const topSignals = (result) => result.checks.filter((c) => c.points > 0).sort((a, b) => b.points - a.points).slice(0, 2).map((c) => c.label).join(' · ') || '—';

function csv(rows) { return rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n'); }

/* =================================================================== */
/* Dashboard                                                           */
/* =================================================================== */

function allFindings() {
  const out = [];
  for (const r of S.scans.instagram?.results || []) if (r.ok) out.push({ key: 'ig:' + r.handle, kind: 'ig', title: r.profile.fullName || '@' + r.handle, sub: '@' + r.handle, img: r.profile.profilePic, src: 'Instagram', result: r.result, row: r });
  for (const r of S.scans.appstore?.results || []) out.push({ key: 'app:' + r.app.trackId, kind: 'app', title: r.app.name, sub: r.app.seller, img: r.app.icon, src: 'App Store', result: r.result, row: r });
  return out;
}
const isOpen = (f) => !f.result.excluded && f.result.severity !== 'Low' && !['Resolved', 'False positive'].includes(S.findings.items[f.key]?.status);

function dashboard(v) {
  headerActions(`<button class="btn" id="hScanIg">${ICON.scan}Scan Instagram</button><button class="btn pri" id="hScanApp">${ICON.scan}Scan App Store</button>`);
  $('#hScanIg').onclick = () => scanInstagram(); $('#hScanApp').onclick = () => scanAppStore();
  if (!brandReady()) {
    v.innerHTML = `${progressEl}<section class="panel warm" style="padding:28px">
      <span class="pill in">Step 1 of 3</span>
      <h2 style="font-size:26px;letter-spacing:-.8px;margin-top:12px">Set up your brand profile</h2>
      <p class="note" style="color:var(--text);opacity:.85;font-size:14px;max-width:620px;margin:8px 0 18px">FraudLens compares every Instagram account and App Store listing against your official registry. Add your brand name, official Instagram accounts and apps first. They are never flagged.</p>
      <div class="row"><a class="btn white" href="#/brand">Open brand profile</a>${S.config.demo ? '<button class="btn" id="loadDemo">Load the demo brand</button>' : ''}</div></section>`;
    $('#loadDemo')?.addEventListener('click', loadDemo);
    return;
  }
  const all = allFindings();
  const open = all.filter(isOpen);
  const high = open.filter((f) => f.result.severity === 'High').length;
  const excluded = all.filter((f) => f.result.excluded).length;
  const checked = all.length;
  const share = open.length ? Math.round(100 * high / open.length) : 0;
  const queue = all.filter((f) => !f.result.excluded && !['Resolved', 'False positive'].includes(S.findings.items[f.key]?.status)).sort((a, b) => b.result.score - a.result.score).slice(0, 8);
  const igScan = S.scans.instagram, apScan = S.scans.appstore;
  const health = (s) => (!s ? '<span class="pill outline">Not run</span>' : s.partial ? '<span class="pill md">Partial</span>' : '<span class="pill lo">Complete</span>');
  v.innerHTML = `${progressEl}
  <section class="panel" style="padding:22px 24px"><div class="kpis">
    <div class="kpi"><div class="k">Open threats</div><div class="v">${open.length}</div><div class="delta">High or Medium, not resolved</div></div>
    <div class="kpi"><div class="k">High risk</div><div class="v">${high}</div><div class="delta">${high ? '<span class="neg">Review these first</span>' : 'None right now'}</div></div>
    <div class="kpi"><div class="k">Official excluded</div><div class="v">${excluded}</div><div class="delta">Matched your official registry</div></div>
    <div class="kpi"><div class="k">Checked</div><div class="v">${checked}</div><div class="delta">Accounts and related apps</div></div>
  </div></section>
  <div class="cols">
    <section class="panel" aria-labelledby="q-h">
      <div class="ph"><div><h2 id="q-h">Priority review queue</h2><p>Highest scores across Instagram and the App Store</p></div></div>
      ${queue.length ? `<div class="tw"><table><thead><tr><th>Candidate</th><th>Why</th><th>Risk</th><th><span class="hidden">Action</span></th></tr></thead><tbody>
        ${queue.map((f) => `<tr><td><div class="ent"><img class="${f.kind === 'ig' ? 'pfp' : 'icon-img'}" src="${esc(imgSrc(f.img))}" alt="" loading="lazy"><div><strong>${esc(f.title)}${f.kind === 'ig' ? vbadge(f.row.profile.isVerified) : ''}</strong><small class="mono">${esc(f.sub)}</small></div></div></td><td class="small" style="max-width:200px">${f.src} · ${esc(S.findings.items[f.key]?.status || 'New')}<br>${esc(topSignals(f.result))}</td><td>${riskCell(f.result)}</td><td><button class="btn sm" data-open="${esc(f.key)}">Review</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><strong>Nothing to review yet</strong>Run an Instagram or App Store scan to fill the queue.</div>`}
    </section>
    <div class="stack">
      <section class="panel" aria-labelledby="g-h">
        <div class="ph" style="margin-bottom:4px"><h2 id="g-h">Open findings</h2>${high ? `<span class="pill hi">${high} high</span>` : ''}</div>
        <div class="gauge" role="img" aria-label="${share}% of open findings are high risk"><div class="ring" style="background:conic-gradient(from 225deg,var(--accent) 0 ${(share * 2.7).toFixed(1)}deg,var(--tick) ${(share * 2.7).toFixed(1)}deg 270deg,transparent 270deg 360deg)"></div>
          <div class="mid"><span class="small">High-risk share</span><strong style="font-size:30px;letter-spacing:-1px">${share}%</strong><span class="small">${high} of ${open.length} open</span></div></div>
        <div class="hr" style="margin:10px 0 14px"></div>
        <div class="kv"><span>Instagram scan</span><b>${igScan ? ago(igScan.at) : 'never'} ${health(igScan)}</b><span>App Store scan</span><b>${apScan ? ago(apScan.at) : 'never'} ${health(apScan)}</b><span>Data mode</span><b>${S.config.demo ? 'Demo data' : 'Live'}</b></div>
      </section>
      <section class="panel" aria-labelledby="a-h">
        <div class="ph" style="margin-bottom:12px"><h2 id="a-h">Recent activity</h2></div>
        ${S.findings.activity.length ? `<div class="rows">${S.findings.activity.slice(0, 6).map((a) => `<div class="rowc"><div class="ri" style="color:${a.kind === 'high' ? 'var(--neg)' : 'var(--accent-text)'}">${a.kind === 'high' ? '!' : '•'}</div><div class="grow"><strong>${esc(a.text)}</strong><span class="small">${ago(a.at)}</span></div></div>`).join('')}</div>` : '<p class="note">No activity yet.</p>'}
      </section>
    </div>
  </div>`;
  bindStatus(v);
  $$('[data-open]', v).forEach((b) => b.addEventListener('click', () => openFinding(b.dataset.open)));
}

async function loadDemo() {
  await api('/api/demo/reset', { method: 'POST' });
  await loadState(); chrome(); rerender();
  toast('Demo brand loaded. Run a scan to see it work.');
}

export function openFinding(key) {
  const f = allFindings().find((x) => x.key === key);
  if (!f) return;
  if (f.kind === 'ig') socialDetail(f.row); else appDetail(f.row);
}

/* =================================================================== */
/* Social monitoring                                                    */
/* =================================================================== */

let socialFilter = 'All';

function social(v) {
  const scan = S.scans.instagram;
  headerActions(`${scan ? `<button class="btn" id="hCsv">${ICON.down}Export CSV</button>` : ''}<button class="btn pri" id="hScan">${ICON.scan}Scan watchlist</button>`);
  $('#hScan').onclick = () => scanInstagram();
  $('#hCsv')?.addEventListener('click', exportSocialCsv);
  const wl = S.watchlist.instagram || [];
  const rows = (scan?.results || []).slice().sort((a, b) => (b.ok - a.ok) || ((a.ok && a.result.excluded) - (b.ok && b.result.excluded)) || ((b.result?.score || 0) - (a.result?.score || 0)));
  const filtered = rows.filter((r) => socialFilter === 'All' || (r.ok && (socialFilter === 'Official' ? r.result.excluded : !r.result.excluded && r.result.severity === socialFilter)) || (socialFilter === 'Errors' && !r.ok));
  const counts = { High: 0, Medium: 0, Low: 0, Official: 0, Errors: 0 };
  for (const r of rows) { if (!r.ok) counts.Errors++; else if (r.result.excluded) counts.Official++; else counts[r.result.severity]++; }
  v.innerHTML = `${progressEl}
  <section class="panel" aria-labelledby="wl-h">
    <div class="ph"><div><h2 id="wl-h">Instagram watchlist</h2><p>Accounts to check. Paste usernames or profile URLs, separated by commas or new lines.</p></div><a class="btn sm" href="#/variants">Find look-alike usernames</a></div>
    <form class="row" id="wlForm"><input type="text" id="wlInput" placeholder="@username or instagram.com/username" aria-label="Instagram username to add" style="flex:1 1 280px"><button class="btn" type="submit">Add</button></form>
    <div class="chips" style="margin-top:12px">${wl.length ? wl.map((h) => `<span class="tag-x"><span class="mono">@${esc(h)}</span><button type="button" data-rm="${esc(h)}" aria-label="Remove @${esc(h)}">×</button></span>`).join('') : '<span class="note">The watchlist is empty.</span>'}</div>
    ${(S.brand.instagram || []).length ? `<p class="note" style="margin-top:12px">Official accounts (${S.brand.instagram.map((h) => '@' + esc(h)).join(', ')}) are read on every scan for their IDs, pictures and posts, and are never flagged.</p>` : ''}
  </section>
  ${scan ? `<section class="panel" aria-labelledby="res-h">
    <div class="ph"><div><h2 id="res-h">Results</h2><p>Scanned ${ago(scan.at)} · ${rows.length} account${rows.length === 1 ? '' : 's'}${scan.partial ? ' · <span class="neg">partial: some data was unavailable</span>' : ''}</p></div>
      <div class="segs" role="group" aria-label="Filter">${['All', 'High', 'Medium', 'Low', 'Official', 'Errors'].filter((k) => k === 'All' || counts[k]).map((k) => `<button class="segb${socialFilter === k ? ' on' : ''}" data-filter="${k}">${k}${k !== 'All' ? ' ' + counts[k] : ''}</button>`).join('')}</div></div>
    ${officialStrip(scan)}
    <div class="tw"><table><thead><tr><th>Account</th><th>Audience</th><th>Risk</th><th>Top signals</th><th>Status</th><th><span class="hidden">Action</span></th></tr></thead><tbody>
      ${filtered.map((r) => r.ok ? `<tr><td><div class="ent"><img class="pfp" src="${esc(imgSrc(r.profile.profilePic))}" alt="" loading="lazy"><div><strong>${esc(r.profile.fullName || r.handle)}${vbadge(r.profile.isVerified)}</strong><small class="mono">@${esc(r.handle)}${r.profile.limited ? ' · limited data' : ''}${r.stale ? ' · cached' : ''}</small></div></div></td>
        <td>${fmt(r.profile.followers)} followers<span class="small">${fmt(r.profile.mediaCount)} posts${r.profile.isPrivate ? ' · private' : ''}</span></td>
        <td>${riskCell(r.result)}</td><td class="small" style="max-width:220px">${r.result.excluded ? 'On the official registry' : esc(topSignals(r.result))}</td>
        <td>${r.result.excluded ? '—' : statusSelect('ig:' + r.handle)}</td><td><button class="btn sm" data-detail="${esc(r.handle)}">Review</button></td></tr>`
        : `<tr class="err-row"><td><div class="ent"><div class="av">!</div><div><strong>@${esc(r.handle)}</strong><small>${esc(r.code === 'not_found' ? 'Account not found' : 'Unavailable')}</small></div></div></td><td colspan="4">${esc(r.error)}</td><td><button class="btn sm" data-retry="${esc(r.handle)}">Retry</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing in this filter.</td></tr>'}
    </tbody></table></div></section>`
  : `<div class="empty"><strong>No scan yet</strong>Add accounts above, then select Scan watchlist.</div>`}`;

  $('#wlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = $('#wlInput').value.split(/[\s,]+/).map(D.parseHandle).filter(Boolean);
    const bad = raw.filter((h) => !/^[a-z0-9._]{1,30}$/.test(h));
    const good = raw.filter((h) => /^[a-z0-9._]{1,30}$/.test(h) && !wl.includes(h));
    if (bad.length) toast(`Not valid usernames: ${bad.join(', ')}`, 'err');
    if (!good.length) return;
    S.watchlist.instagram = [...wl, ...good]; await saveWatchlist();
    toast(`Added ${good.map((h) => '@' + h).join(', ')}`); rerender();
  });
  $$('[data-rm]', v).forEach((b) => b.addEventListener('click', async () => { S.watchlist.instagram = wl.filter((h) => h !== b.dataset.rm); await saveWatchlist(); rerender(); }));
  $$('[data-filter]', v).forEach((b) => b.addEventListener('click', () => { socialFilter = b.dataset.filter; rerender(); }));
  $$('[data-detail]', v).forEach((b) => b.addEventListener('click', () => socialDetail(rows.find((r) => r.handle === b.dataset.detail))));
  $$('[data-retry]', v).forEach((b) => b.addEventListener('click', () => scanInstagram()));
  bindStatus(v);
}

function officialStrip(scan) {
  if (!scan.official?.length) return '';
  const ok = scan.official.filter((o) => o.ok), bad = scan.official.filter((o) => !o.ok);
  // Group failures by reason so seven identical errors read as one line.
  const byReason = new Map();
  for (const o of bad) byReason.set(o.error, [...(byReason.get(o.error) || []), o.handle]);
  const fails = [...byReason].map(([err, hs]) => `<div class="issue error" style="margin-bottom:8px">${hs.length === 1 ? 'Official @' + esc(hs[0]) + ' was' : hs.length + ' official accounts were'} not read: ${esc(err)}${hs.length > 1 ? `<span class="small" style="display:block;margin-top:2px">${hs.map((h) => '@' + esc(h)).join(', ')}</span>` : ''}</div>`).join('');
  return `${fails}<div class="chips" style="margin-bottom:14px">${ok.map((o) => `<span class="chip">Official @${esc(o.handle)}${o.verified ? ' ✓' : ''} · ${fmt(o.followers)} followers${o.limited ? ' · limited' : ''}${o.stale ? ' · cached' : ''}</span>`).join('')}
    <span class="chip">${scan.logoCount} reference image${scan.logoCount === 1 ? '' : 's'} · ${scan.officialPostCount} official post${scan.officialPostCount === 1 ? '' : 's'}</span></div>`;
}

function checksHtml(result) {
  if (result.excluded) return `<p class="note">${esc(result.guardrails.join(' '))}</p>`;
  return `<div class="checks">${result.checks.map((c) => `<div class="chk-row"><div><strong style="font-weight:500">${esc(c.id)} ${esc(c.label)}</strong>${c.status === 'unavailable' ? '<span class="na">not available</span>' : ''}</div>
    <div class="ev">${c.evidence.map((e) => `<div>${esc(e)}</div>`).join('')}</div>
    <div class="pts ${c.points === 0 ? 'zero' : c.points < 0 ? 'neg' : ''}">${c.points > 0 ? '+' : ''}${c.points}<span class="small" style="display:inline"> /${c.max}</span></div></div>`).join('')}</div>
    ${result.guardrails.length ? `<div class="glass" style="padding:10px 14px;margin-top:12px;font-size:12px">${result.guardrails.map(esc).join('<br>')}</div>` : ''}`;
}

function historyHtml(key) {
  const h = S.findings.items[key]?.history || [];
  return h.length ? `<div class="rows">${h.slice(-6).reverse().map((x) => `<div class="rowc"><div class="grow"><strong>${esc(x.text)}</strong></div><span class="time">${new Date(x.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')}</div>` : '<p class="note">No history yet.</p>';
}

function socialDetail(r) {
  if (!r?.ok) return;
  const p = r.profile, res = r.result, key = 'ig:' + r.handle;
  const copied = new Set((res.copies || []).map((c) => c.post.shortcode));
  const link = 'https://www.instagram.com/' + encodeURIComponent(r.handle) + '/';
  openModal(`
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="row" style="gap:14px"><img class="pfp lg" src="${esc(imgSrc(p.profilePic))}" alt="Profile picture of @${esc(r.handle)}">
        <div><h2 style="font-size:22px;letter-spacing:-.5px">${esc(p.fullName || r.handle)}${vbadge(p.isVerified)}</h2><p class="note mono">@${esc(r.handle)} · Instagram · ${esc(p.source || '')}${r.stale ? ' · cached ' + ago(r.cachedAt) : ''}</p></div></div>
      <div class="acts"><a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${ICON.ext}Open on Instagram</a><button class="btn icon" data-dismiss aria-label="Close">${ICON.close}</button></div>
    </div>
    ${p.limited ? '<div class="issue" style="margin-bottom:12px">Limited data: Instagram refused its data endpoint, so only the public profile page was read. Name, picture and counts were checked; the full bio, links and posts were not. Add an Instagram session or Graph API token in Monitoring sources for every check.</div>' : ''}
    <div class="panel" style="padding:18px 22px"><div class="kpis">
      <div class="kpi"><div class="k">Risk score</div><div class="v">${res.excluded ? '—' : res.score}<span class="small" style="display:inline;font-weight:400">${res.excluded ? '' : ' / 100'}</span></div>${pill(res.severity)}</div>
      <div class="kpi"><div class="k">Followers</div><div class="v">${fmt(p.followers)}</div><div class="delta">${fmt(p.following)} following</div></div>
      <div class="kpi"><div class="k">Posts</div><div class="v">${fmt(p.mediaCount)}</div><div class="delta">${p.isPrivate ? 'Private account' : p.limited ? 'Posts not readable' : (p.posts?.length || 0) + ' visible'}</div></div>
      <div class="kpi"><div class="k">Confidence</div><div class="v">${res.confidence ?? 100}%</div><div class="delta">Share of checks that could run</div></div>
    </div></div>
    <div class="two">
      <div class="box"><h3>Profile</h3><div class="kv2">
        <span>Bio</span><div style="white-space:pre-wrap">${esc(p.bio) || `<span class="muted">${p.limited ? 'Not readable (limited data)' : 'Empty'}</span>`}</div>
        <span>Link</span><div>${safeUrl(p.externalUrl) ? `<a href="${esc(p.externalUrl)}" target="_blank" rel="noopener noreferrer nofollow">${esc(D.hostOf(p.externalUrl))}</a>` : `<span class="muted">${p.limited ? 'Not readable (limited data)' : 'None'}</span>`}</div>
        <span>Account ID</span><div class="mono">${esc(p.id || 'not available')}</div>
        <span>Category</span><div>${esc(p.category || '—')}</div>
      </div></div>
      <div class="box"><h3>Status and history</h3>${res.excluded ? '<p class="note">Official accounts have no status.</p>' : `<div class="row" style="margin-bottom:12px">${STATUSES.map((s) => `<button class="btn sm${(S.findings.items[key]?.status || 'New') === s ? ' pri' : ''}" data-set="${s}">${s}</button>`).join('')}</div>`}${historyHtml(key)}</div>
    </div>
    <div class="box"><h3>Why it scored ${res.excluded ? '—' : res.score}</h3>${checksHtml(res)}</div>
    ${(p.posts || []).length ? `<div class="box"><h3>Recent posts${copied.size ? ` · <span class="neg">${copied.size} copied from an official account</span>` : ''}</h3><div class="posts">${p.posts.map((x) => `<a href="${esc(safeUrl(x.url) || link)}" target="_blank" rel="noopener noreferrer" title="${esc((x.caption || '').slice(0, 140))}"><img src="${esc(imgSrc(x.thumb))}" alt="Post ${esc(x.shortcode)}" loading="lazy">${copied.has(x.shortcode) ? '<span class="copy">Copied</span>' : ''}</a>`).join('')}</div></div>` : ''}
    <div class="row"><button class="btn" id="evJson">${ICON.down}Evidence (JSON)</button><span class="spacer"></span><span class="note">A score ranks findings for review. It is not proof on its own.</span></div>`, {
    label: 'Instagram account @' + r.handle,
    onOpen: (m) => {
      $$('[data-set]', m).forEach((b) => b.addEventListener('click', async () => { await setStatus(key, b.dataset.set); closeModal(); rerender(); socialDetail(r); }));
      $('#evJson', m).addEventListener('click', () => download(`fraudlens-evidence-${r.handle}.json`, JSON.stringify(evidence(key, { platform: 'instagram', handle: r.handle, url: link, profile: { ...p, posts: (p.posts || []).map((x) => ({ shortcode: x.shortcode, url: x.url, takenAt: x.takenAt ? new Date(x.takenAt).toISOString() : null, caption: x.caption })) } }, res), null, 2)));
    }
  });
}

function evidence(key, subject, res) {
  return { generatedAt: new Date().toISOString(), tool: 'FraudLens MVP', brand: S.brand.name, officialRegistry: D.officialRegistry(S.brand), subject, score: res.score, severity: res.severity, confidence: res.confidence, checks: res.checks, guardrails: res.guardrails, status: S.findings.items[key]?.status || 'New', history: S.findings.items[key]?.history || [], note: 'A risk score ranks findings for human review; it is not proof of wrongdoing on its own.' };
}

function exportSocialCsv() {
  const rows = [['username', 'display_name', 'followers', 'posts', 'verified', 'score', 'severity', 'status', 'signals', 'error']];
  for (const r of S.scans.instagram?.results || []) rows.push(r.ok ? [r.handle, r.profile.fullName, r.profile.followers, r.profile.mediaCount, r.profile.isVerified, r.result.excluded ? '' : r.result.score, r.result.severity, S.findings.items['ig:' + r.handle]?.status || 'New', r.result.checks.filter((c) => c.points).map((c) => `${c.id} ${c.points}`).join('; '), ''] : [r.handle, '', '', '', '', '', '', '', '', r.error]);
  download('fraudlens-instagram.csv', csv(rows), 'text/csv');
}

/* =================================================================== */
/* App Store                                                            */
/* =================================================================== */

const COUNTRIES = [['in', 'India'], ['us', 'United States'], ['gb', 'United Kingdom'], ['ae', 'UAE'], ['sg', 'Singapore'], ['au', 'Australia'], ['ca', 'Canada'], ['de', 'Germany']];

function apps(v) {
  const scan = S.scans.appstore;
  headerActions(`${scan ? `<button class="btn" id="hCsv">${ICON.down}Export CSV</button>` : ''}<button class="btn pri" id="hScan">${ICON.scan}Scan App Store</button>`);
  $('#hScan').onclick = () => scanAppStore();
  $('#hCsv')?.addEventListener('click', () => {
    const rows = [['app_store_id', 'name', 'bundle_id', 'developer', 'score', 'severity', 'status', 'signals', 'url']];
    for (const r of scan.results) rows.push([r.app.trackId, r.app.name, r.app.bundleId, r.app.seller, r.result.excluded ? '' : r.result.score, r.result.severity, S.findings.items['app:' + r.app.trackId]?.status || 'New', r.result.checks.filter((c) => c.points).map((c) => `${c.id} ${c.points}`).join('; '), r.app.url]);
    download('fraudlens-appstore.csv', csv(rows), 'text/csv');
  });
  const terms = S.watchlist.appTerms?.length ? S.watchlist.appTerms : [S.brand.name, ...(S.brand.aliases || [])].filter(Boolean);
  const official = scan?.officialApps || [];
  v.innerHTML = `${progressEl}
  <section class="panel" aria-labelledby="t-h">
    <div class="ph"><div><h2 id="t-h">Search</h2><p>FraudLens searches the Apple App Store for each term and scores every related result.</p></div></div>
    <form class="row" id="termForm"><input type="text" id="termInput" placeholder="Add a search term" aria-label="Search term" style="flex:1 1 240px">
      <button class="btn" type="submit">Add term</button>
      <label class="row" style="gap:8px">Store country <select id="country" style="width:auto">${COUNTRIES.map(([c, n]) => `<option value="${c}"${(S.brand.country || 'in') === c ? ' selected' : ''}>${n}</option>`).join('')}</select></label></form>
    <div class="chips" style="margin-top:12px">${terms.map((t) => `<span class="tag-x">${esc(t)}<button type="button" data-rmt="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join('') || '<span class="note">Add a term, or the brand name is used.</span>'}</div>
  </section>
  ${scan ? `
  ${official.length ? `<section class="panel"><div class="ph"><div><h2>Official apps</h2><p>Looked up from your brand profile. Their icons, descriptions and developer IDs are the reference.</p></div></div><div class="rows">${official.map((o) => `<div class="rowc"><img class="icon-img" src="${esc(imgSrc(o.icon))}" alt=""><div class="grow"><strong>${esc(o.name)}</strong><span class="small">${esc(o.seller)} · <span class="mono">${esc(o.bundleId)}</span> · developer ID ${esc(o.artistId)}</span></div><span class="pill lo">Official</span></div>`).join('')}</div></section>` : ''}
  <section class="panel" aria-labelledby="ar-h">
    <div class="ph"><div><h2 id="ar-h">Results</h2><p>Scanned ${ago(scan.at)} · store ${esc(scan.country.toUpperCase())} · ${scan.results.length} related, ${scan.unrelated} unrelated results ignored</p></div></div>
    ${(scan.warnings || []).map((w) => `<div class="issue warn" style="margin-bottom:8px">${esc(w)}</div>`).join('')}
    ${scan.results.length ? `<div class="tw"><table><thead><tr><th>App</th><th>Developer</th><th>Risk</th><th>Top signals</th><th>Status</th><th><span class="hidden">Action</span></th></tr></thead><tbody>
      ${scan.results.map((r) => `<tr><td><div class="ent"><img class="icon-img" src="${esc(imgSrc(r.app.icon))}" alt="" loading="lazy"><div><strong>${esc(r.app.name)}</strong><small class="mono">${esc(r.app.bundleId)}</small></div></div></td>
        <td>${esc(r.app.seller)}<span class="small">${fmt(r.app.ratingCount)} ratings · ${esc((r.app.releaseDate || '').slice(0, 10))}</span></td>
        <td>${riskCell(r.result)}</td><td class="small" style="max-width:220px">${r.result.excluded ? esc(r.result.guardrails[0] || 'Official') : esc(topSignals(r.result))}</td>
        <td>${r.result.excluded ? '—' : statusSelect('app:' + r.app.trackId)}</td><td><button class="btn sm" data-app="${esc(r.app.trackId)}">Review</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty"><strong>No related apps found</strong>Nothing in the results resembled your brand.</div>'}
  </section>` : `<div class="empty"><strong>No scan yet</strong>Select Scan App Store to search for look-alike apps.</div>`}`;

  $('#termForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#termInput').value.trim();
    if (!t) return;
    S.watchlist.appTerms = [...new Set([...terms, t])]; await saveWatchlist(); rerender();
  });
  $$('[data-rmt]', v).forEach((b) => b.addEventListener('click', async () => { S.watchlist.appTerms = terms.filter((t) => t !== b.dataset.rmt); await saveWatchlist(); rerender(); }));
  $('#country').addEventListener('change', async (e) => { S.brand.country = e.target.value; await saveBrand(); toast('Store country: ' + e.target.selectedOptions[0].text); });
  $$('[data-app]', v).forEach((b) => b.addEventListener('click', () => appDetail(scan.results.find((r) => r.app.trackId === b.dataset.app))));
  bindStatus(v);
}

function appDetail(r) {
  if (!r) return;
  const a = r.app, res = r.result, key = 'app:' + a.trackId;
  openModal(`
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div class="row" style="gap:14px"><img class="icon-img lg" src="${esc(imgSrc(a.icon))}" alt="Icon of ${esc(a.name)}">
        <div><h2 style="font-size:22px;letter-spacing:-.5px">${esc(a.name)}</h2><p class="note">${esc(a.seller)} · <span class="mono">${esc(a.bundleId)}</span></p></div></div>
      <div class="acts">${safeUrl(a.url) ? `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${ICON.ext}Open in App Store</a>` : ''}<button class="btn icon" data-dismiss aria-label="Close">${ICON.close}</button></div>
    </div>
    <div class="panel" style="padding:18px 22px"><div class="kpis">
      <div class="kpi"><div class="k">Risk score</div><div class="v">${res.excluded ? '—' : res.score}</div>${pill(res.severity)}</div>
      <div class="kpi"><div class="k">Ratings</div><div class="v">${fmt(a.ratingCount)}</div><div class="delta">${a.rating ? a.rating.toFixed(1) + ' average' : 'No average'}</div></div>
      <div class="kpi"><div class="k">Released</div><div class="v" style="font-size:20px;margin:12px 0 8px">${esc((a.releaseDate || '').slice(0, 10) || '—')}</div><div class="delta">${esc(a.genre)}</div></div>
      <div class="kpi"><div class="k">Confidence</div><div class="v">${res.confidence ?? 100}%</div><div class="delta">Share of checks that could run</div></div>
    </div></div>
    <div class="two">
      <div class="box"><h3>Listing</h3><div class="kv2"><span>App Store ID</span><div class="mono">${esc(a.trackId)}</div><span>Developer ID</span><div class="mono">${esc(a.artistId)}</div><span>Developer site</span><div>${safeUrl(a.sellerUrl) ? esc(D.hostOf(a.sellerUrl)) : '—'}</div><span>Description</span><div style="max-height:150px;overflow:auto;white-space:pre-wrap">${esc((a.description || '').slice(0, 1200))}</div></div></div>
      <div class="box"><h3>Status and history</h3>${res.excluded ? '<p class="note">Official apps have no status.</p>' : `<div class="row" style="margin-bottom:12px">${STATUSES.map((s) => `<button class="btn sm${(S.findings.items[key]?.status || 'New') === s ? ' pri' : ''}" data-set="${s}">${s}</button>`).join('')}</div>`}${historyHtml(key)}</div>
    </div>
    <div class="box"><h3>Why it scored ${res.excluded ? '—' : res.score}</h3>${checksHtml(res)}</div>
    <div class="row"><button class="btn" id="evJson">${ICON.down}Evidence (JSON)</button></div>`, {
    label: 'App ' + a.name,
    onOpen: (m) => {
      $$('[data-set]', m).forEach((b) => b.addEventListener('click', async () => { await setStatus(key, b.dataset.set); closeModal(); rerender(); appDetail(r); }));
      $('#evJson', m).addEventListener('click', () => download(`fraudlens-evidence-app-${a.trackId}.json`, JSON.stringify(evidence(key, { platform: 'app-store', app: { ...a, iconHash: undefined } }, res), null, 2)));
    }
  });
}

/* =================================================================== */
/* Name variants                                                        */
/* =================================================================== */

let probe = { results: {}, base: '' };

function variants(v) {
  headerActions('');
  const base = probe.base || S.brand.name || '';
  const list = D.generateVariants(base, { max: 40 });
  const compiled = D.compileBrand(S.brand);
  v.innerHTML = `${progressEl}
  <div class="cols">
    <section class="panel" aria-labelledby="gen-h">
      <div class="ph"><div><h2 id="gen-h">Generated look-alike usernames</h2><p>The usernames an impersonator is most likely to register. Select some and check whether they exist.</p></div></div>
      <form class="row" id="baseForm" style="margin-bottom:12px"><input type="text" id="baseInput" value="${esc(base)}" aria-label="Name to generate variants from" style="flex:1 1 240px"><button class="btn" type="submit">Generate</button></form>
      ${list.length ? `<div class="row" style="margin-bottom:10px"><button class="btn pri" id="probeBtn">Check selected on Instagram</button><span class="note" id="selCount"></span></div>
      <div class="tw"><table><thead><tr><th style="width:40px"><input type="checkbox" id="selAll" aria-label="Select all"></th><th>Username</th><th>Technique</th><th>On Instagram</th></tr></thead><tbody>
        ${list.map((x, i) => { const pr = probe.results[x.handle]; return `<tr><td><input type="checkbox" class="sel" value="${esc(x.handle)}"${i < 8 ? ' checked' : ''} aria-label="Select @${esc(x.handle)}"></td><td class="mono">@${esc(x.handle)}</td><td>${esc(x.technique)}</td>
          <td>${!pr ? '<span class="small">Not checked</span>' : pr.exists ? `<span class="pill hi">Taken</span> ${S.watchlist.instagram.includes(x.handle) ? '<span class="small" style="display:inline">in watchlist</span>' : `<button class="btn sm" data-watch="${esc(x.handle)}">Add to watchlist</button>`}` : pr.code === 'not_found' ? '<span class="pill lo">Not taken</span>' : `<span class="pill md" title="${esc(pr.error)}">Unknown</span>`}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty"><strong>Enter a name</strong>At least 3 letters.</div>'}
    </section>
    <section class="panel warm" aria-labelledby="tr-h">
      <h2 id="tr-h">Lookalike tester</h2>
      <p class="note" style="color:var(--text);opacity:.85;margin-bottom:14px">Type any username or app name to see how FraudLens reads it.</p>
      <div class="field"><label for="tryInput">Name to test</label><input type="text" id="tryInput" value="N0rthstar_supp0rt" autocomplete="off"></div>
      <div id="tryOut" style="margin-top:14px"></div>
    </section>
  </div>`;
  const out = () => {
    const s = $('#tryInput').value;
    const nm = brandReady() || S.brand.name ? D.nameMatch(s, compiled) : null;
    const subs = D.substitutions(s);
    $('#tryOut').innerHTML = `<div class="kv2"><span>Plain</span><div class="mono">${esc(D.plain(s))}</div><span>Reads as</span><div class="mono">${esc(D.skeleton(s))}</div>
      <span>Substitutions</span><div>${subs.length ? subs.map((x) => `<span class="chip">"${esc(x.ch)}" → ${esc(x.as)} <span class="small" style="display:inline">${esc(x.code)}</span></span>`).join(' ') : 'None'}</div>
      ${nm ? `<span>Name match</span><div>${nm.s1 || nm.s2 ? `<strong>S1 +${nm.s1}${nm.s2 ? ` · S2 +${nm.s2}` : ''}</strong> ${esc(nm.detail)}` : 'No resemblance to the brand.'}</div>` : '<span>Name match</span><div class="muted">Add a brand name to compare.</div>'}</div>`;
  };
  $('#tryInput').addEventListener('input', out); out();
  $('#baseForm').addEventListener('submit', (e) => { e.preventDefault(); probe.base = $('#baseInput').value.trim(); rerender(); });
  const count = () => { const n = $$('.sel:checked', v).length; if ($('#selCount')) $('#selCount').textContent = `${n} selected · about ${Math.ceil(n * 1.3)} s`; };
  $$('.sel', v).forEach((c) => c.addEventListener('change', count)); count();
  $('#selAll')?.addEventListener('change', (e) => { $$('.sel', v).forEach((c) => { c.checked = e.target.checked; }); count(); });
  $('#probeBtn')?.addEventListener('click', async () => {
    const handles = $$('.sel:checked', v).map((c) => c.value);
    if (!handles.length) return toast('Select at least one username.', 'err');
    if (handles.length > 25) return toast('Check 25 or fewer at a time to avoid Instagram rate limits.', 'err');
    const res = await probeHandles(handles);
    for (const r of res) probe.results[r.handle] = r;
    const taken = res.filter((r) => r.exists).length;
    toast(`${taken} of ${res.length} usernames are taken.`); rerender();
  });
  $$('[data-watch]', v).forEach((b) => b.addEventListener('click', async () => {
    S.watchlist.instagram = [...new Set([...S.watchlist.instagram, b.dataset.watch])]; await saveWatchlist();
    toast('@' + b.dataset.watch + ' added to the watchlist.'); rerender();
  }));
}

/* =================================================================== */
/* Brand profile                                                        */
/* =================================================================== */

let draft = null;
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const lines = (s) => String(s || '').split(/\n/);

function draftFromBrand(b) {
  return {
    name: b.name, aliases: (b.aliases || []).join(', '), keywords: (b.keywords || []).join(', '), genericWords: (b.genericWords || []).join(', '), isCommonWord: !!b.isCommonWord,
    domains: (b.domains || []).join(', '), instagram: (b.instagram || []).map((h) => '@' + h).join('\n'), partners: (b.partners || []).map((h) => '@' + h).join('\n'),
    apps: (b.apps || []).map((a) => [a.label, a.bundleId || (a.trackId ? 'id' + a.trackId : '')].filter(Boolean).join(' | ')).join('\n'),
    publishers: (b.publishers || []).join(', '), logo: b.logo || '', logoHash: b.logoHash || '', country: b.country || 'in'
  };
}
function brandFromDraft(d) {
  const instagram = [...new Set(lines(d.instagram).map(D.parseHandle).filter((h) => /^[a-z0-9._]{1,30}$/.test(h)))];
  const apps = lines(d.apps).map(D.parseAppLine).filter((a) => a && (a.trackId || /^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(a.bundleId)));
  return {
    name: d.name.trim(), aliases: list(d.aliases), keywords: list(d.keywords), genericWords: list(d.genericWords), isCommonWord: d.isCommonWord,
    domains: list(d.domains).map(D.hostOf).filter(Boolean), instagram, partners: lines(d.partners).map(D.parseHandle).filter(Boolean), apps, publishers: list(d.publishers),
    logo: d.logo, logoHash: d.logoHash, country: d.country,
    instagramLines: lines(d.instagram), appLines: lines(d.apps)
  };
}

function brand(v) {
  if (!draft) draft = draftFromBrand(S.brand);
  headerActions(`<a class="btn" href="/official-channels.json" target="_blank" rel="noopener">${ICON.ext}Published registry</a><button class="btn pri" id="hSave">Save brand profile</button>`);
  v.innerHTML = `${progressEl}
  <div class="cols">
    <section class="panel" aria-labelledby="bp-h"><form id="bpForm" novalidate>
      <div class="ph"><div><h2 id="bp-h">Official registry</h2><p>Everything here is excluded from alerts and used as the reference for every check.</p></div></div>
      <div class="two" style="gap:18px 16px">
        <div class="field"><label for="f-name">Brand or company name *</label><input type="text" id="f-name" data-k="name" value="${esc(draft.name)}" required></div>
        <div class="field"><label for="f-aliases">Aliases</label><input type="text" id="f-aliases" data-k="aliases" value="${esc(draft.aliases)}" placeholder="Short names, separated by commas"></div>
        <div class="field"><label for="f-keywords">Brand keywords</label><input type="text" id="f-keywords" data-k="keywords" value="${esc(draft.keywords)}" placeholder="Product names, slogans"></div>
        <div class="field"><label for="f-domains">Official website domains</label><input type="text" id="f-domains" data-k="domains" value="${esc(draft.domains)}" placeholder="brand.com, brand.in"></div>
        <div class="field"><label for="f-ig">Official Instagram accounts</label><textarea id="f-ig" data-k="instagram" placeholder="@brand&#10;instagram.com/brand_support">${esc(draft.instagram)}</textarea><span class="help">One per line. Handles or profile URLs.</span></div>
        <div class="field"><label for="f-apps">Official iOS apps</label><textarea id="f-apps" data-k="apps" placeholder="Brand App | com.brand.app&#10;Brand Pay | id1234567890">${esc(draft.apps)}</textarea><span class="help">One per line: name | bundle ID, App Store ID or App Store URL.</span></div>
        <div class="field"><label for="f-pub">Official publishers / developers</label><input type="text" id="f-pub" data-k="publishers" value="${esc(draft.publishers)}" placeholder="Exact developer names on the App Store"></div>
        <div class="field"><label for="f-partners">Approved partners and resellers</label><textarea id="f-partners" data-k="partners" style="min-height:64px" placeholder="@reseller_account">${esc(draft.partners)}</textarea></div>
        <div class="field"><label for="f-generic">Generic words to ignore</label><input type="text" id="f-generic" data-k="genericWords" value="${esc(draft.genericWords)}" placeholder="Words in your name that are too common, e.g. labs"></div>
        <div class="field"><span class="lbl2">Logo for image matching</span>
          <div class="row">${draft.logo ? `<img class="logo-prev" src="${esc(imgSrc(draft.logo))}" alt="Current logo">` : '<div class="logo-prev" style="display:grid;place-items:center;color:var(--muted);font-size:11px">No logo</div>'}
          <div class="stack" style="gap:8px"><label class="btn sm" style="cursor:pointer">Upload logo<input type="file" id="f-logo" accept="image/png,image/jpeg,image/webp" class="hidden"></label>${draft.logo ? '<button type="button" class="btn sm ghost" id="rmLogo">Remove</button>' : ''}</div></div>
          <span class="help">${draft.logoHash ? 'Fingerprint saved: ' + esc(draft.logoHash.slice(0, 16)) + '…' : 'PNG or JPG, at least 64 × 64 px.'}</span></div>
        <label class="row" style="grid-column:1/-1;gap:10px;font-weight:400"><input type="checkbox" id="f-common" ${draft.isCommonWord ? 'checked' : ''}> The brand name is an ordinary word (needs more evidence before flagging)</label>
      </div>
    </form></section>
    <aside class="stack">
      <section class="panel warm" aria-labelledby="st-h"><h2 id="st-h">Profile strength</h2><div id="strength"></div></section>
      <section class="panel" aria-labelledby="iss-h"><h2 id="iss-h" style="margin-bottom:10px">Validation</h2><div id="issues" class="issues"></div></section>
      <section class="panel" aria-labelledby="ver-h"><div class="ph" style="margin-bottom:10px"><div><h2 id="ver-h">Check official assets</h2><p>Confirm the accounts and apps exist, and pull developer names.</p></div></div>
        <div class="row"><button class="btn sm" id="verIg">Check Instagram accounts</button><button class="btn sm" id="verApps">Look up apps</button></div><div id="verOut" style="margin-top:12px"></div></section>
    </aside>
  </div>`;

  const sync = () => {
    const b = brandFromDraft(draft);
    const val = D.validateBrand(b);
    $('#strength').innerHTML = `<div style="display:flex;align-items:baseline;gap:10px;margin:12px 0 10px"><strong style="font-size:44px;letter-spacing:-1.5px;line-height:1">${val.strength}%</strong><span class="pill ${val.strength >= 70 ? 'lo' : val.strength >= 40 ? 'md' : 'hi'}">${val.strength >= 70 ? 'Good' : val.strength >= 40 ? 'Fair' : 'Weak'}</span></div><div class="ticks" role="img" aria-label="${val.strength}%"><i style="width:${val.strength}%"></i></div>
      <div style="margin-top:14px">${val.checks.map((c) => `<div class="row" style="padding:6px 0;font-size:13px"><span class="pill ${c.ok ? 'lo' : 'outline'}" style="min-width:24px;justify-content:center">${c.ok ? '✓' : '+'}</span>${esc(c.label)}</div>`).join('')}</div>`;
    $('#issues').innerHTML = val.issues.length ? val.issues.map((i) => `<div class="issue ${i.level}">${esc(i.msg)}</div>`).join('') : '<div class="issue" style="background:var(--lo-bg);color:var(--lo)">All entries look valid.</div>';
    return { b, val };
  };
  $$('[data-k]', v).forEach((el) => el.addEventListener('input', () => { draft[el.dataset.k] = el.value; sync(); }));
  $('#f-common').addEventListener('change', (e) => { draft.isCommonWord = e.target.checked; sync(); });
  $('#f-logo').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { draft.logo = await shrinkImage(file); draft.logoHash = (await hashImage(draft.logo)) || ''; rerender(); toast('Logo added. Save to keep it.'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#rmLogo')?.addEventListener('click', () => { draft.logo = ''; draft.logoHash = ''; rerender(); });
  sync();

  $('#hSave').onclick = async () => {
    const { b, val } = sync();
    if (!b.name) { $('#f-name').focus(); return toast('Enter the brand name.', 'err'); }
    const errors = val.issues.filter((i) => i.level === 'error' && i.field !== 'instagram' || (i.level === 'error' && /handle/.test(i.msg)));
    if (errors.length) return toast('Fix the highlighted entries first: ' + errors[0].msg, 'err');
    const { instagramLines, appLines, ...clean } = b;
    S.brand = { ...S.brand, ...clean };
    await saveBrand(); logActivity('Brand profile saved'); await saveFindings();
    draft = draftFromBrand(S.brand); chrome(); rerender();
    toast(brandReady() ? 'Brand profile saved. Official assets are now excluded from alerts.' : 'Saved. Add an official Instagram account or app to start scanning.');
  };

  $('#verIg').addEventListener('click', async () => {
    const handles = brandFromDraft(draft).instagram;
    if (!handles.length) return toast('Add an official Instagram account first.', 'err');
    $('#verOut').innerHTML = '<p class="note">Checking…</p>';
    const rows = [];
    for (const h of handles) {
      try { const { profile } = await api('/api/instagram/profile?username=' + encodeURIComponent(h)); rows.push(`<div class="rowc"><img class="pfp" src="${esc(imgSrc(profile.profilePic))}" alt=""><div class="grow"><strong>@${esc(h)}${vbadge(profile.isVerified)}</strong><span class="small">${esc(profile.fullName)} · ${fmt(profile.followers)} followers</span></div><span class="pill lo">Found</span></div>`); }
      catch (e) { rows.push(`<div class="rowc"><div class="ri">!</div><div class="grow"><strong>@${esc(h)}</strong><span class="small">${esc(e.message)}</span></div><span class="pill hi">Problem</span></div>`); }
    }
    $('#verOut').innerHTML = `<div class="rows">${rows.join('')}</div>`;
  });
  $('#verApps').addEventListener('click', async () => {
    const appsL = brandFromDraft(draft).apps;
    if (!appsL.length) return toast('Add an official app first.', 'err');
    $('#verOut').innerHTML = '<p class="note">Looking up…</p>';
    try {
      const ids = appsL.map((a) => a.trackId).filter(Boolean), bids = appsL.map((a) => a.bundleId).filter(Boolean);
      let found = [];
      if (ids.length) found.push(...(await api(`/api/appstore/lookup?country=${draft.country}&id=${ids.join(',')}`)).results);
      if (bids.length) found.push(...(await api(`/api/appstore/lookup?country=${draft.country}&bundleId=${bids.join(',')}`)).results);
      found = found.filter((f, i) => found.findIndex((x) => x.trackId === f.trackId) === i && (ids.includes(f.trackId) || bids.map((b) => b.toLowerCase()).includes(f.bundleId.toLowerCase())));
      const missing = appsL.filter((a) => !found.some((f) => f.trackId === a.trackId || f.bundleId.toLowerCase() === (a.bundleId || '').toLowerCase()));
      const pubs = [...new Set(found.map((f) => f.seller).filter(Boolean))];
      $('#verOut').innerHTML = `<div class="rows">${found.map((f) => `<div class="rowc"><img class="icon-img" src="${esc(imgSrc(f.icon))}" alt=""><div class="grow"><strong>${esc(f.name)}</strong><span class="small">${esc(f.seller)} · <span class="mono">${esc(f.bundleId)}</span></span></div><span class="pill lo">Found</span></div>`).join('')}
        ${missing.map((m) => `<div class="rowc"><div class="ri">!</div><div class="grow"><strong>${esc(m.label || m.bundleId || m.trackId)}</strong><span class="small">Not found in the ${esc(draft.country.toUpperCase())} store</span></div><span class="pill hi">Missing</span></div>`).join('')}</div>
        ${pubs.length ? `<button class="btn sm" id="usePubs" style="margin-top:10px">Use developer names: ${esc(pubs.join(', '))}</button>` : ''}`;
      $('#usePubs')?.addEventListener('click', () => { draft.publishers = [...new Set([...list(draft.publishers), ...pubs])].join(', '); rerender(); toast('Developer names added. Save to keep them.'); });
    } catch (e) { $('#verOut').innerHTML = `<div class="issue error">${esc(e.message)}</div>`; }
  });
}

/* =================================================================== */
/* Sources                                                              */
/* =================================================================== */

function sources(v) {
  headerActions('');
  const c = S.config;
  v.innerHTML = `${progressEl}
  <div class="two">
    <section class="panel" aria-labelledby="ig-h">
      <div class="ph"><div><h2 id="ig-h">Instagram</h2><p>How FraudLens reads Instagram profiles.</p></div><span class="pill ${c.demo ? 'in' : 'lo'}">${c.demo ? 'Demo data' : 'Live'}</span></div>
      <div class="stack" style="gap:8px" role="radiogroup" aria-label="Instagram source">
        ${[['auto', 'Automatic', 'Graph API when a token is saved, otherwise public profiles (using the saved session, if any).'], ['web', 'Public profiles', 'No setup. Reads any public profile. If Instagram rate-limits it, FraudLens falls back to the public profile page (name, picture and counts only). Results are cached for 6 hours.'], ['graph', 'Instagram Graph API', 'Official. Needs a Meta app token and your Instagram business account ID. Sees business and creator accounts only.']]
          .map(([k, n, d]) => `<label class="mi radio${c.igMode === k ? ' on' : ''}" style="cursor:pointer"><input type="radio" name="igMode" value="${k}" ${c.igMode === k ? 'checked' : ''} ${c.hosted ? 'disabled' : ''}><span><span style="display:block">${n}</span><small>${d}</small></span></label>`).join('')}
      </div>
      <div class="two" style="margin-top:14px;gap:12px">
        <div class="field"><label for="gUser">Your Instagram business account ID</label><input type="text" id="gUser" ${c.hosted ? 'disabled' : ''} value="${esc(c.graphUserId || '')}" placeholder="1784…"></div>
        <div class="field"><label for="gTok">Graph API access token</label><input type="password" id="gTok" ${c.hosted ? 'disabled' : ''} value="${c.graphConfigured ? '••••' : ''}" placeholder="Paste a long-lived token" autocomplete="off"></div>
      </div>
      <div class="field" style="margin-top:12px"><label for="igSess">Instagram session (optional)</label><input type="password" id="igSess" ${c.hosted ? 'disabled' : ''} value="${c.sessionConfigured ? '••••' : ''}" placeholder="Paste the sessionid cookie value" autocomplete="off">
        <p class="help">Lets public-profile reads get full data when Instagram blocks anonymous requests. Use a spare account, not your main one: Instagram can restrict accounts used for automated reads. Clear the field and save to remove it.</p></div>
      <p class="help" style="margin-top:6px">${c.hosted ? 'This hosted demo can\'t save tokens or sessions, because it is shared with everyone who opens it. Run FraudLens on your own computer to connect Instagram.' : 'Tokens and sessions are stored only in <span class="code">data/config.json</span> on this computer.'}</p>
      <div class="row" style="margin-top:14px"><button class="btn pri" id="saveIg" ${c.hosted ? 'disabled' : ''}>Save</button><button class="btn" id="testIg">Test with an official account</button></div>
      <div id="testIgOut" style="margin-top:12px"></div>
    </section>
    <div class="stack">
      <section class="panel" aria-labelledby="as-h">
        <div class="ph"><div><h2 id="as-h">Apple App Store</h2><p>Public iTunes Search API. No key needed; about 20 requests a minute; results cached for 1 hour.</p></div><span class="pill ${c.demo ? 'in' : 'lo'}">${c.demo ? 'Demo data' : 'Live'}</span></div>
        <button class="btn" id="testApp">Test App Store search</button><div id="testAppOut" style="margin-top:12px"></div>
      </section>
      <section class="panel" aria-labelledby="dm-h">
        <div class="ph"><div><h2 id="dm-h">Demo data</h2><p>Bundled sample accounts and apps for presenting without internet. Live sources are not called while it is on.</p></div></div>
        ${c.hosted ? '<p class="note">This hosted copy always uses the bundled demo data. Changes you make here are shared with everyone viewing it and reset from time to time. Run FraudLens on your own computer for live Instagram and App Store data.</p>' : c.demoForced ? '<p class="note">Started with <span class="code">--demo</span>; restart without it for live data.</p>' : `<label class="row" style="gap:10px"><input type="checkbox" id="demoToggle" ${c.demo ? 'checked' : ''}> Use demo data</label>`}
        ${c.demo ? '<button class="btn sm" id="demoReset" style="margin-top:12px">Load the demo brand and watchlist</button>' : ''}
      </section>
      <section class="panel" aria-labelledby="ca-h">
        <div class="ph"><div><h2 id="ca-h">When a source is unavailable</h2></div></div>
        <ul class="note" style="margin:0 0 12px;padding-left:18px;line-height:1.7"><li>FraudLens shows the last good result, marked “cached”, and marks the scan partial.</li><li>Checks that could not run add no points and lower the confidence figure.</li><li>Accounts that fail show a reason and a Retry button.</li></ul>
        <button class="btn sm danger" id="clearCache">Clear cached profiles and listings</button>
      </section>
    </div>
  </div>`;
  $$('input[name=igMode]', v).forEach((r) => r.addEventListener('change', () => { $$('.mi.radio', v).forEach((l) => l.classList.toggle('on', l.querySelector('input').checked)); }));
  $('#saveIg').addEventListener('click', async () => {
    const body = { igMode: $('input[name=igMode]:checked', v)?.value || 'auto', graphUserId: $('#gUser').value.trim(), graphToken: $('#gTok').value.trim(), igSessionId: $('#igSess').value.trim() };
    if (body.igMode === 'graph' && (!body.graphUserId || !body.graphToken)) return toast('The Graph API needs both an account ID and a token.', 'err');
    const r = await api('/api/config', { method: 'PUT', body }); S.config = r.config; chrome(); toast('Instagram source saved.'); rerender();
  });
  $('#testIg').addEventListener('click', async () => {
    const h = (S.brand.instagram || [])[0] || 'instagram';
    $('#testIgOut').innerHTML = '<p class="note">Fetching @' + esc(h) + '…</p>';
    try { const r = await api('/api/instagram/profile?fresh=1&username=' + encodeURIComponent(h)); $('#testIgOut').innerHTML = `<div class="issue" style="background:var(--lo-bg);color:var(--lo)">Working: @${esc(r.profile.username)} · ${fmt(r.profile.followers)} followers · source ${esc(r.profile.source)}${r.profile.limited ? ' (limited: public page only)' : ''}${r.stale ? ' (live fetch failed, cached copy shown: ' + esc(r.warning) + ')' : ''}</div>`; }
    catch (e) { $('#testIgOut').innerHTML = `<div class="issue error">${esc(e.message)}</div>`; }
  });
  $('#testApp').addEventListener('click', async () => {
    $('#testAppOut').innerHTML = '<p class="note">Searching…</p>';
    try { const r = await api(`/api/appstore/search?country=${S.brand.country || 'in'}&term=${encodeURIComponent(S.brand.name || 'instagram')}`); $('#testAppOut').innerHTML = `<div class="issue" style="background:var(--lo-bg);color:var(--lo)">Working: ${r.results.length} results for "${esc(S.brand.name || 'instagram')}"${r.cached ? ' (cached)' : ''}.</div>`; }
    catch (e) { $('#testAppOut').innerHTML = `<div class="issue error">${esc(e.message)}</div>`; }
  });
  $('#demoToggle')?.addEventListener('change', async (e) => { const r = await api('/api/config', { method: 'PUT', body: { demo: e.target.checked } }); S.config = r.config; chrome(); rerender(); toast(e.target.checked ? 'Demo data on.' : 'Live data on.'); });
  $('#demoReset')?.addEventListener('click', async () => { await loadDemo(); draft = null; });
  $('#clearCache').addEventListener('click', async () => { await api('/api/cache', { method: 'DELETE' }); toast('Cache cleared.'); });
}

/* =================================================================== */

const VIEWS = { dashboard, social, apps, variants, brand, sources };
export function renderView(route) {
  if (route !== 'brand') draft = null;
  const v = $('#view');
  VIEWS[route](v);
}
