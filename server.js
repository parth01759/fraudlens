// FraudLens MVP server — zero dependencies, Node 18+.
// Serves the app, stores state in ./data, and fetches Instagram profiles and App Store listings.
//   node server.js            live mode
//   node server.js --demo     demo mode (bundled sample data, no network)
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { officialRegistry, parseHandle } from './public/js/detect.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const FIXTURES = path.join(ROOT, 'fixtures');
const PORT = Number(process.env.PORT || 4321);
const DEMO_FLAG = process.argv.includes('--demo') || process.env.FRAUDLENS_DEMO === '1';

const IG_APP_ID = '936619743392459'; // Instagram web app id used by instagram.com itself
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IG_TTL = 6 * 3600e3;
const APP_TTL = 3600e3;
const IMG_HOSTS = ['cdninstagram.com', 'fbcdn.net', 'mzstatic.com'];

/* ---------------- storage ---------------- */

const DEFAULTS = {
  'brand.json': { name: '', aliases: [], keywords: [], genericWords: [], isCommonWord: false, domains: [], instagram: [], partners: [], apps: [], publishers: [], logo: '', logoHash: '', country: 'in' },
  'watchlist.json': { instagram: [], appTerms: [] },
  'findings.json': { items: {}, activity: [] },
  'scans.json': { instagram: null, appstore: null },
  'config.json': { igMode: 'auto', graphToken: '', graphUserId: '', demo: false, country: 'in' }
};

async function readJson(name) {
  try { return { ...structuredClone(DEFAULTS[name]), ...JSON.parse(await fs.readFile(path.join(DATA, name), 'utf8')) }; }
  catch { return structuredClone(DEFAULTS[name]); }
}
async function writeJson(name, value) {
  const file = path.join(DATA, name);
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2));
  await fs.rename(file + '.tmp', file);
}
async function cacheGet(key, ttl) {
  try {
    const f = path.join(CACHE, key + '.json');
    const st = await fs.stat(f);
    const value = JSON.parse(await fs.readFile(f, 'utf8'));
    return { value, age: Date.now() - st.mtimeMs, fresh: Date.now() - st.mtimeMs < ttl };
  } catch { return null; }
}
async function cacheSet(key, value) { await fs.writeFile(path.join(CACHE, key + '.json'), JSON.stringify(value)); }
const safeKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 80);

async function isDemo() { return DEMO_FLAG || (await readJson('config.json')).demo === true; }

/* ---------------- Instagram ---------------- */

let igQueue = Promise.resolve();
function igSerial(fn) { // one request at a time, 1.2 s apart, to stay polite and avoid rate limits
  const run = igQueue.then(fn, fn);
  igQueue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1200)));
  return run;
}

class FetchError extends Error { constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; } }

function normaliseWebUser(u) {
  const edges = u.edge_owner_to_timeline_media?.edges || [];
  return {
    platform: 'instagram', source: 'public-web', id: String(u.id || ''), username: u.username, fullName: u.full_name || '',
    bio: u.biography || '', externalUrl: u.external_url || '', bioLinks: (u.bio_links || []).map((l) => l.url).filter(Boolean),
    profilePic: u.profile_pic_url_hd || u.profile_pic_url || '', isVerified: !!u.is_verified, isPrivate: !!u.is_private,
    isBusiness: !!u.is_business_account, category: u.category_name || u.business_category_name || '',
    followers: u.edge_followed_by?.count ?? null, following: u.edge_follow?.count ?? null,
    mediaCount: u.edge_owner_to_timeline_media?.count ?? null,
    posts: edges.slice(0, 12).map(({ node: n }) => ({
      id: n.id, shortcode: n.shortcode, takenAt: (n.taken_at_timestamp || 0) * 1000,
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || '', thumb: n.thumbnail_src || n.display_url || '',
      isVideo: !!n.is_video, url: 'https://www.instagram.com/p/' + n.shortcode + '/'
    }))
  };
}

function normaliseGraph(d) {
  return {
    platform: 'instagram', source: 'graph-api', id: '', username: d.username, fullName: d.name || '', bio: d.biography || '',
    externalUrl: d.website || '', bioLinks: [], profilePic: d.profile_picture_url || '', isVerified: null, isPrivate: false,
    isBusiness: true, category: '', followers: d.followers_count ?? null, following: d.follows_count ?? null, mediaCount: d.media_count ?? null,
    posts: (d.media?.data || []).map((m) => ({ id: m.id, shortcode: (m.permalink || '').split('/').filter(Boolean).pop() || m.id, takenAt: Date.parse(m.timestamp) || 0, caption: m.caption || '', thumb: m.media_type === 'VIDEO' ? (m.thumbnail_url || '') : (m.media_url || ''), isVideo: m.media_type === 'VIDEO', url: m.permalink || '' }))
  };
}

async function fetchWeb(username, session = '') {
  const headers = { 'x-ig-app-id': IG_APP_ID, 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', referer: `https://www.instagram.com/${username}/`, 'x-requested-with': 'XMLHttpRequest' };
  if (session) headers.cookie = `sessionid=${session}`;
  const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
    headers,
    redirect: 'manual', signal: AbortSignal.timeout(15000)
  });
  if (res.status === 404) throw new FetchError('not_found', `@${username} does not exist.`, 404);
  if (res.status === 429) throw new FetchError('rate_limited', 'Instagram is rate-limiting requests. Wait a while, or add an Instagram session or Graph API token in Monitoring sources.', 429);
  if (res.status >= 300 && res.status < 400 || res.status === 401) throw new FetchError('login_required', session ? 'Instagram rejected the saved session (it may have expired or been logged out). Paste a fresh one in Monitoring sources.' : 'Instagram asked for a login. Add an Instagram session or Graph API token in Monitoring sources, or try again later.', 503);
  if (!res.ok) throw new FetchError('upstream', `Instagram answered ${res.status}.`, 502);
  const json = await res.json().catch(() => null);
  const user = json?.data?.user;
  if (!user) throw new FetchError('not_found', `@${username} does not exist.`, 404);
  return normaliseWebUser(user);
}

/* Public profile page: what link previews read. Gives name, picture and counts when the data endpoint is refused. */
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const decodeHtml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m));
function parseCount(s) {
  const m = String(s || '').replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}
async function fetchPage(username) {
  const res = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
    headers: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
    redirect: 'follow', signal: AbortSignal.timeout(15000)
  });
  if (res.status === 404) throw new FetchError('not_found', `@${username} does not exist.`, 404);
  if (res.status === 429) throw new FetchError('rate_limited', 'Instagram is rate-limiting requests, including public profile pages. Wait a while, or add an Instagram session or Graph API token in Monitoring sources.', 429);
  if (!res.ok) throw new FetchError('upstream', `Instagram answered ${res.status}.`, 502);
  const html = await res.text();
  const meta = (p) => decodeHtml((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i')) || [])[1]);
  const desc = meta('og:description') || meta('description');
  const title = meta('og:title');
  const counts = desc.match(/([\d.,]+[KMB]?)\s+Followers?,\s*([\d.,]+[KMB]?)\s+Following,\s*([\d.,]+[KMB]?)\s+Posts?/i);
  if (!counts) {
    if (/accounts\/login/i.test(res.url) || /login/i.test(title)) throw new FetchError('login_required', 'Instagram asked for a login. Add an Instagram session or Graph API token in Monitoring sources.', 503);
    if (/page (isn.t|is not) available|page not found/i.test(html.slice(0, 20000))) throw new FetchError('not_found', `@${username} does not exist.`, 404);
    // A page without profile details proves nothing either way: report it as unavailable, never as "not found".
    throw new FetchError('upstream', 'Instagram\'s public profile page did not include profile details.', 502);
  }
  const name = (title.match(/^(.*?)\s*\(@[^)]+\)/) || [])[1] || (desc.match(/from\s+(.*?)\s*\(@/) || [])[1] || '';
  const bio = (desc.match(/on Instagram:\s*["“]([\s\S]*)["”]\s*$/) || [])[1] || '';
  const id = (html.match(/profilePage_(\d{4,})/) || html.match(/"profile_id"\s*:\s*"(\d{4,})"/) || [])[1] || '';
  return {
    platform: 'instagram', source: 'public-page', limited: true, id, username, fullName: decodeHtml(name), bio: decodeHtml(bio),
    externalUrl: '', bioLinks: [], profilePic: meta('og:image'), isVerified: null, isPrivate: null, isBusiness: null, category: '',
    followers: parseCount(counts[1]), following: parseCount(counts[2]), mediaCount: parseCount(counts[3]), posts: []
  };
}

async function fetchGraph(username, cfg) {
  const fields = `business_discovery.username(${username}){username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(12){caption,timestamp,media_type,media_url,thumbnail_url,permalink}}`;
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.graphUserId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(cfg.graphToken)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const msg = json.error.message || 'Graph API error';
    if (/does not exist|cannot be found|Invalid user id/i.test(msg)) throw new FetchError('not_found', `@${username} was not found as a business or creator account.`, 404);
    if (json.error.code === 4 || json.error.code === 17 || json.error.code === 32) throw new FetchError('rate_limited', 'Graph API rate limit reached.', 429);
    throw new FetchError('upstream', msg, 502);
  }
  return normaliseGraph(json.business_discovery);
}

async function demoProfile(username) {
  const f = path.join(FIXTURES, 'instagram', safeKey(username) + '.json');
  if (!existsSync(f)) throw new FetchError('not_found', `@${username} does not exist (demo data).`, 404);
  const p = JSON.parse(await fs.readFile(f, 'utf8'));
  const now = Date.now();
  // fixtures store post ages in days so the demo stays current
  p.posts = (p.posts || []).map((x) => ({ ...x, takenAt: x.daysAgo != null ? now - x.daysAgo * 864e5 : x.takenAt }));
  return { ...p, source: 'demo' };
}

async function getProfile(username, { fresh = false } = {}) {
  const u = parseHandle(username);
  if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new FetchError('bad_handle', `"${username}" isn't a valid Instagram username.`, 400);
  if (await isDemo()) return { profile: await demoProfile(u), cached: false };
  const cfg = await readJson('config.json');
  const key = 'ig_' + safeKey(u);
  const hit = await cacheGet(key, IG_TTL);
  // Limited (public-page) copies are retried after 15 minutes in case full data is available again.
  if (hit?.fresh && !fresh && !(hit.value.limited && hit.age > 15 * 60e3)) return { profile: hit.value, cached: true, cachedAt: Date.now() - hit.age };
  try {
    const useGraph = cfg.igMode === 'graph' || (cfg.igMode === 'auto' && cfg.graphToken && cfg.graphUserId);
    const profile = await igSerial(async () => {
      if (useGraph) return fetchGraph(u, cfg);
      try { return await fetchWeb(u, cfg.igSessionId); }
      catch (e) {
        // Data endpoint refused (common when logged out): fall back to the public profile page.
        if (e instanceof FetchError && e.code === 'not_found') throw e;
        try { return await fetchPage(u); }
        catch (e2) { throw e2 instanceof FetchError && ['not_found', 'rate_limited', 'login_required'].includes(e2.code) ? e2 : (e instanceof FetchError ? e : e2); }
      }
    });
    profile.fetchedAt = Date.now();
    await cacheSet(key, profile);
    return { profile, cached: false };
  } catch (err) {
    const e = err instanceof FetchError ? err : new FetchError('network', 'Could not reach Instagram: ' + (err.cause?.code || err.message), 502);
    if (hit && e.code !== 'not_found') return { profile: hit.value, cached: true, stale: true, cachedAt: Date.now() - hit.age, warning: e.message };
    throw e;
  }
}

/* ---------------- App Store ---------------- */

function normaliseApp(a) {
  return {
    trackId: String(a.trackId), name: a.trackName, bundleId: a.bundleId || '', seller: a.sellerName || '', artistId: String(a.artistId || ''),
    artistName: a.artistName || '', sellerUrl: a.sellerUrl || '', description: a.description || '', icon: a.artworkUrl512 || a.artworkUrl100 || a.artworkUrl60 || '',
    releaseDate: a.releaseDate || '', genre: a.primaryGenreName || '', ratingCount: a.userRatingCount ?? 0, rating: a.averageUserRating ?? null,
    url: a.trackViewUrl || '', price: a.formattedPrice || '', version: a.version || ''
  };
}

async function itunes(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const key = 'app_' + crypto.createHash('sha1').update(endpoint + qs).digest('hex').slice(0, 16);
  if (await isDemo()) {
    const f = path.join(FIXTURES, 'appstore', endpoint + '.json');
    const all = JSON.parse(await fs.readFile(f, 'utf8'));
    if (endpoint === 'lookup') {
      const ids = String(params.id || '').split(','); const bids = String(params.bundleId || '').split(',');
      return { results: all.results.filter((r) => ids.includes(String(r.trackId)) || bids.includes(r.bundleId)).map(normaliseApp), cached: false };
    }
    const t = String(params.term || '').toLowerCase().split(/\s+/)[0];
    return { results: all.results.filter((r) => (r.trackName + ' ' + r.description + ' ' + r.sellerName).toLowerCase().includes(t)).map(normaliseApp), cached: false };
  }
  const hit = await cacheGet(key, APP_TTL);
  if (hit?.fresh) return { results: hit.value, cached: true };
  try {
    const res = await fetch(`https://itunes.apple.com/${endpoint}?${qs}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 429) throw new FetchError('rate_limited', 'Apple is rate-limiting requests (about 20 a minute). Try again shortly.', 429);
    if (!res.ok) throw new FetchError('upstream', `App Store answered ${res.status}.`, 502);
    const json = await res.json();
    const results = (json.results || []).filter((r) => r.kind === 'software' || r.wrapperType === 'software' || r.trackId).map(normaliseApp);
    await cacheSet(key, results);
    return { results, cached: false };
  } catch (e) {
    if (hit) return { results: hit.value, cached: true, stale: true, warning: e.message };
    throw e instanceof FetchError ? e : new FetchError('network', 'Could not reach the App Store: ' + e.message, 502);
  }
}

/* ---------------- image proxy (lets the browser fingerprint remote images) ---------------- */

async function proxyImage(src, res) {
  if (src.startsWith('/fixtures/')) {
    const f = path.join(ROOT, path.normalize(src).replace(/^([/\\])+/, ''));
    if (!f.startsWith(FIXTURES) || !existsSync(f)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': mime(f), 'cache-control': 'max-age=3600' });
    return createReadStream(f).pipe(res);
  }
  let url;
  try { url = new URL(src); } catch { return send(res, 400, { error: 'bad url' }); }
  if (url.protocol !== 'https:' || !IMG_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) return send(res, 403, { error: 'host not allowed' });
  const key = crypto.createHash('sha1').update(src).digest('hex');
  const file = path.join(CACHE, 'img_' + key);
  if (existsSync(file)) { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); return createReadStream(file).pipe(res); }
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.instagram.com/' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return send(res, 502, { error: 'image ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(file, buf);
    res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'max-age=86400' });
    res.end(buf);
  } catch (e) { send(res, 502, { error: e.message }); }
}

/* ---------------- http ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const mime = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8e6) throw new FetchError('too_large', 'Request too large', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new FetchError('bad_json', 'Invalid JSON', 400); }
}
function publicConfig(c) { return { igMode: c.igMode, graphConfigured: !!(c.graphToken && c.graphUserId), sessionConfigured: !!c.igSessionId, graphUserId: c.graphUserId, demo: DEMO_FLAG || c.demo === true, demoForced: DEMO_FLAG, country: c.country }; }

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  try {
    if (p === '/api/state' && req.method === 'GET') {
      const [brand, watchlist, findings, scans, config] = await Promise.all(['brand.json', 'watchlist.json', 'findings.json', 'scans.json', 'config.json'].map(readJson));
      return send(res, 200, { brand, watchlist, findings, scans, config: publicConfig(config) });
    }
    if (p === '/api/brand' && req.method === 'PUT') { const b = await body(req); await writeJson('brand.json', b); return send(res, 200, { ok: true }); }
    if (p === '/api/watchlist' && req.method === 'PUT') { const b = await body(req); await writeJson('watchlist.json', b); return send(res, 200, { ok: true }); }
    if (p === '/api/findings' && req.method === 'PUT') { const b = await body(req); await writeJson('findings.json', b); return send(res, 200, { ok: true }); }
    if (p.startsWith('/api/scans/') && req.method === 'PUT') {
      const kind = p.split('/').pop(); if (!['instagram', 'appstore'].includes(kind)) return send(res, 404, { error: 'unknown scan' });
      const scans = await readJson('scans.json'); scans[kind] = await body(req); await writeJson('scans.json', scans); return send(res, 200, { ok: true });
    }
    if (p === '/api/config' && req.method === 'PUT') {
      const b = await body(req); const c = await readJson('config.json');
      for (const k of ['igMode', 'graphUserId', 'country']) if (b[k] != null) c[k] = String(b[k]);
      if (b.graphToken != null && b.graphToken !== '••••') c.graphToken = String(b.graphToken);
      if (b.igSessionId != null && b.igSessionId !== '••••') { let v = String(b.igSessionId); try { v = decodeURIComponent(v); } catch {} c.igSessionId = v.replace(/^sessionid=/, '').replace(/;.*$/, '').trim(); }
      if (b.demo != null) c.demo = !!b.demo;
      await writeJson('config.json', c); return send(res, 200, { ok: true, config: publicConfig(c) });
    }
    if (p === '/api/cache' && req.method === 'DELETE') {
      for (const f of await fs.readdir(CACHE)) await fs.rm(path.join(CACHE, f), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/demo/reset' && req.method === 'POST') {
      for (const name of ['brand.json', 'watchlist.json', 'findings.json', 'scans.json']) {
        const f = path.join(FIXTURES, 'demo-' + name);
        await writeJson(name, existsSync(f) ? JSON.parse(await fs.readFile(f, 'utf8')) : structuredClone(DEFAULTS[name]));
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/instagram/profile') {
      const r = await getProfile(q.username || '', { fresh: q.fresh === '1' });
      return send(res, 200, r);
    }
    if (p === '/api/appstore/search') {
      if (!q.term) return send(res, 400, { error: 'term required' });
      return send(res, 200, await itunes('search', { term: q.term, entity: 'software', country: q.country || 'in', limit: q.limit || '50' }));
    }
    if (p === '/api/appstore/lookup') {
      const params = { country: q.country || 'in', entity: 'software' };
      if (q.id) params.id = q.id; if (q.bundleId) params.bundleId = q.bundleId;
      if (!params.id && !params.bundleId) return send(res, 400, { error: 'id or bundleId required' });
      return send(res, 200, await itunes('lookup', params));
    }
    if (p === '/api/img') return proxyImage(q.u || '', res);
    if (p === '/official-channels.json') return send(res, 200, officialRegistry(await readJson('brand.json')), { 'access-control-allow-origin': '*' });

    // static files
    let f = p === '/' ? '/index.html' : decodeURIComponent(p);
    const base = f.startsWith('/fixtures/') ? ROOT : PUBLIC;
    const full = path.join(base, path.normalize(f).replace(/^([/\\])+/, ''));
    if (!full.startsWith(base) || !existsSync(full) || (await fs.stat(full)).isDirectory()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': mime(full), 'cache-control': 'no-cache' });
    createReadStream(full).pipe(res);
  } catch (e) {
    const status = e instanceof FetchError ? e.status : 500;
    if (!(e instanceof FetchError)) console.error(e);
    send(res, status, { error: e.message, code: e.code || 'server_error' });
  }
}

await fs.mkdir(CACHE, { recursive: true });
if (!existsSync(path.join(DATA, 'brand.json')) && existsSync(path.join(FIXTURES, 'demo-brand.json')) && DEMO_FLAG) {
  for (const name of ['brand.json', 'watchlist.json']) await fs.copyFile(path.join(FIXTURES, 'demo-' + name), path.join(DATA, name));
}
http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  FraudLens is running at http://localhost:${PORT}${DEMO_FLAG ? '   (demo data mode)' : ''}\n`);
});
