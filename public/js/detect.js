// FraudLens detection engine — pure functions, runs in the browser and in Node.
// Implements the checks in "FraudLens Detection Logic": brand profile validation,
// social checks S1–S10, app store checks A1–A9, guardrails and severity.

/* ------------------------------------------------------------------ */
/* Text normalisation                                                  */
/* ------------------------------------------------------------------ */

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­͏]/g;

// Characters that look like a plain letter. Applied to BOTH sides of a comparison.
// i, l, 1, |, ! all collapse to "l" (as Unicode's confusable skeletons do).
export const CONFUSABLES = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '6': 'b',
  '@': 'a', '$': 's', '!': 'l', '|': 'l', '+': 't', '€': 'e', '£': 'l',
  'i': 'l', 'ı': 'l', 'ǀ': 'l',
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
  'т': 't', 'у': 'y', 'х': 'x', 'і': 'l', 'ї': 'l', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q',
  'ԝ': 'w', 'ү': 'y', 'ɡ': 'g', 'ո': 'n', 'ս': 'u', 'օ': 'o', 'զ': 'q', 'һ': 'h',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'l', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'ω': 'w', 'ϲ': 'c',
  // Latin look-alikes
  'ß': 'b', 'ø': 'o', 'đ': 'd', 'ł': 'l', 'ħ': 'h', 'ŧ': 't', 'ƅ': 'b'
};

function baseFold(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Lowercase letters and digits only, no lookalike mapping. */
export function plain(s) {
  return baseFold(s).replace(/[^a-z0-9]/g, '');
}

/** Lookalike skeleton: two strings with the same skeleton look the same to a person. */
export function skeleton(s) {
  let out = '';
  for (const ch of baseFold(s)) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/[^a-z0-9]/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w');
}

/** Characters in `s` that are lookalike substitutes (digits/symbols/non-Latin). */
export function substitutions(s) {
  const found = [];
  for (const ch of String(s || '').normalize('NFKC')) {
    const low = ch.toLowerCase();
    if (/[a-z]/.test(low) && low !== 'i') continue;
    if (low === 'i') continue;
    const mapped = CONFUSABLES[low];
    if (mapped && !found.some((f) => f.ch === ch)) found.push({ ch, as: mapped, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
  }
  if (ZERO_WIDTH.test(String(s || ''))) found.push({ ch: '·', as: '(invisible character)', code: 'zero-width' });
  ZERO_WIDTH.lastIndex = 0;
  return found;
}

export const GENERIC_WORDS = ['official', 'offical', 'the', 'real', 'app', 'hq', 'inc', 'ltd', 'llc', 'co', 'company', 'global', 'india', 'team', 'page', 'account', 'acc', 'tv', 'store', 'shop', 'online'];
export const RISK_WORDS = ['support', 'help', 'helpdesk', 'care', 'customercare', 'service', 'services', 'giveaway', 'giveaways', 'airdrop', 'verify', 'verification', 'rewards', 'reward', 'prize', 'prizes', 'promo', 'refund', 'refunds', 'recovery', 'admin', 'team', 'desk', 'contact', 'official'];
export const APP_FILLER = ['app', 'pro', 'lite', 'plus', 'free', 'mobile', 'official', 'hd', 'ios', 'iphone', 'ipad', 'new', '2024', '2025', '2026', '2027'];

/** Split a handle or display name into lower-case words. */
export function words(s) {
  return baseFold(String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2'))
    .split(/[^a-z0-9Ѐ-ӿͰ-Ͽ]+/)
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Distances                                                           */
/* ------------------------------------------------------------------ */

/** Damerau-Levenshtein (optimal string alignment): swaps count as one edit. */
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}

/** Smallest edit distance between `needle` and any window of `hay` (approximate substring). */
export function bestWindow(hay, needle) {
  if (!hay || !needle) return { dist: Infinity, at: -1, len: 0 };
  if (hay.includes(needle)) return { dist: 0, at: hay.indexOf(needle), len: needle.length };
  let best = { dist: Infinity, at: -1, len: 0 };
  const L = needle.length;
  for (let len = Math.max(1, L - 2); len <= L + 2; len++) {
    for (let i = 0; i + len <= hay.length; i++) {
      const dd = editDistance(hay.slice(i, i + len), needle);
      if (dd < best.dist || (dd === best.dist && Math.abs(len - L) < Math.abs(best.len - L))) best = { dist: dd, at: i, len };
    }
  }
  if (hay.length < L - 2) best = { dist: editDistance(hay, needle), at: 0, len: hay.length };
  return best;
}

export function shingles(text, k = 3) {
  const w = words(text).filter((x) => x.length > 1);
  const set = new Set();
  if (w.length < k) { if (w.length) set.add(w.join(' ')); return set; }
  for (let i = 0; i + k <= w.length; i++) set.add(w.slice(i, i + k).join(' '));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Hamming distance between two 64-character bit strings (image fingerprints). */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function hostOf(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

/* ------------------------------------------------------------------ */
/* Brand profile                                                       */
/* ------------------------------------------------------------------ */

export const EMPTY_BRAND = {
  name: '', aliases: [], keywords: [], genericWords: [], isCommonWord: false,
  domains: [], instagram: [], partners: [], apps: [], publishers: [], logo: '', logoHash: '', country: 'in'
};

const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

/** Turn "@name", "instagram.com/name/" or a full URL into a bare handle. */
export function parseHandle(line) {
  let s = String(line || '').trim();
  if (!s) return '';
  const m = s.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
  return s;
}

/** Turn "Label | com.x.y" / "id123" / App Store URL into {label, bundleId, trackId}. */
export function parseAppLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const parts = raw.split('|').map((p) => p.trim());
  const idPart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const label = parts.length > 1 ? parts.slice(0, -1).join(' | ') : '';
  const url = idPart.match(/apps\.apple\.com\/.*\/id(\d{5,12})/i);
  if (url) return { label, trackId: url[1], bundleId: '' };
  const id = idPart.match(/^id?(\d{5,12})$/i);
  if (id) return { label, trackId: id[1], bundleId: '' };
  return { label, bundleId: idPart, trackId: '' };
}

const BUNDLE_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/;

export function validateBrand(b) {
  const issues = [];
  const add = (field, level, msg, line) => issues.push({ field, level, msg, line });
  if (!String(b.name || '').trim()) add('name', 'error', 'Brand name is required.');
  else if (plain(b.name).length < 3) add('name', 'warn', 'Very short brand names match many unrelated accounts.');

  const seen = new Map();
  (b.instagramLines || []).forEach((line, i) => {
    if (!line.trim()) return;
    const h = parseHandle(line);
    if (!HANDLE_RE.test(h)) add('instagram', 'error', `"${line.trim()}" isn't an Instagram handle or profile URL.`, i);
    else if (seen.has(h)) add('instagram', 'warn', `"${line.trim()}" duplicates line ${seen.get(h) + 1}.`, i);
    else seen.set(h, i);
  });
  (b.appLines || []).forEach((line, i) => {
    if (!line.trim()) return;
    const a = parseAppLine(line);
    if (!a || (!a.trackId && !BUNDLE_RE.test(a.bundleId))) add('apps', 'error', `"${line.trim()}" needs a bundle ID (com.brand.app) or App Store ID (id123456789).`, i);
  });
  (b.domains || []).forEach((d) => { if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostOf(d))) add('domains', 'error', `"${d}" isn't a valid domain.`); });
  if (!(b.instagram || []).length && !(b.apps || []).length) add('instagram', 'error', 'Add at least one official Instagram account or app before scanning.');

  const checks = [
    ['Brand name', !!String(b.name || '').trim(), 15],
    ['Aliases or keywords', (b.aliases || []).length + (b.keywords || []).length > 0, 10],
    ['Official Instagram accounts', (b.instagram || []).length > 0, 20],
    ['Official apps', (b.apps || []).length > 0, 15],
    ['Official publishers', (b.publishers || []).length > 0, 10],
    ['Official website / domains', (b.domains || []).length > 0, 15],
    ['Logo for image matching', !!b.logoHash, 15]
  ];
  const strength = checks.reduce((s, [, ok, w]) => s + (ok ? w : 0), 0) - issues.filter((x) => x.level === 'error').length * 5;
  return { issues, checks: checks.map(([label, ok, weight]) => ({ label, ok, weight })), strength: Math.max(0, Math.min(100, strength)), ready: !issues.some((x) => x.level === 'error') };
}

/** Compile the brand profile into the lookup sets the detectors use. */
export function compileBrand(b, extra = {}) {
  const names = [b.name, ...(b.aliases || [])].map((s) => String(s || '').trim()).filter(Boolean);
  const official = (b.instagram || []).map(parseHandle).filter(Boolean);
  const generic = new Set([...GENERIC_WORDS, ...(b.genericWords || []).map((w) => plain(w))]);
  return {
    raw: b,
    names,
    nameSkeletons: names.map((n) => ({ name: n, sk: skeleton(n), pl: plain(n), words: words(n).map(skeleton) })),
    officialHandles: new Set(official),
    officialSkeletons: official.map((h) => ({ handle: h, sk: skeleton(h) })),
    partners: new Set((b.partners || []).map(parseHandle).filter(Boolean)),
    keywords: [...names, ...(b.keywords || [])].map((k) => String(k).trim()).filter(Boolean),
    domains: (b.domains || []).map(hostOf).filter(Boolean),
    generic,
    isCommonWord: !!b.isCommonWord,
    bundleIds: new Set((b.apps || []).map((a) => String(a.bundleId || '').toLowerCase()).filter(Boolean)),
    trackIds: new Set((b.apps || []).map((a) => String(a.trackId || '')).filter(Boolean)),
    publishers: (b.publishers || []).map((p) => String(p).trim()).filter(Boolean),
    // Filled at scan time from live lookups of the official assets:
    officialIds: new Set(extra.officialIds || []),
    officialMaxId: extra.officialMaxId || null,
    developerIds: new Set((extra.developerIds || []).map(String)),
    officialApps: extra.officialApps || [],
    officialPosts: extra.officialPosts || []
  };
}

/** The public "official channels" registry the brand's website publishes. */
export function officialRegistry(b) {
  return {
    brand: b.name,
    updated: new Date().toISOString().slice(0, 10),
    instagram: (b.instagram || []).map((h) => ({ handle: '@' + parseHandle(h), url: 'https://www.instagram.com/' + parseHandle(h) + '/' })),
    partners: (b.partners || []).map((h) => '@' + parseHandle(h)),
    apps: (b.apps || []).map((a) => ({ name: a.label || '', bundleId: a.bundleId || '', appStoreId: a.trackId || '' })),
    publishers: b.publishers || [],
    domains: b.domains || []
  };
}

/* ------------------------------------------------------------------ */
/* Name similarity (S1, S2, A1) — shared look-alike engine             */
/* ------------------------------------------------------------------ */

function stripWords(str, drop) {
  const w = words(str);
  const kept = w.filter((x) => !drop.has(plain(x)));
  return { kept, dropped: w.filter((x) => drop.has(plain(x))) };
}

/**
 * Compare one candidate string against the brand names and official handles.
 * Returns S1 points (0–25), S2 points (0–10) and a readable explanation.
 */
export function nameMatch(candidate, brand, { filler = [] } = {}) {
  const drop = new Set([...brand.generic, ...filler.map(plain)]);
  const cand = String(candidate || '');
  const { kept } = stripWords(cand, drop);
  const candSk = skeleton(kept.join('')) || skeleton(cand);
  const candPl = plain(kept.join('')) || plain(cand);
  const candWords = kept.map(skeleton);
  const subs = substitutions(cand);
  let best = { s1: 0, s2: 0, kind: 'none', target: '', detail: 'No resemblance to the brand name.' };
  const consider = (r) => { if (r.s1 + r.s2 > best.s1 + best.s2) best = r; };

  const targets = [...brand.nameSkeletons.map((n) => ({ label: n.name, sk: skeleton(stripWords(n.name, drop).kept.join('')) || n.sk, pl: plain(stripWords(n.name, drop).kept.join('')) || n.pl, words: n.words, strict: !!n.strict })),
    ...brand.officialSkeletons.map((o) => ({ label: '@' + o.handle, sk: o.sk, pl: plain(o.handle), words: [] }))];

  for (const t of targets) {
    if (!t.sk || t.sk.length < 3) continue;
    const disguised = subs.length > 0 && !candPl.includes(t.pl) && (candSk === t.sk || candSk.includes(t.sk));
    const s2 = disguised ? 10 : 0;
    if (candSk === t.sk) {
      consider({ s1: 25, s2, kind: disguised ? 'disguised' : 'exact', target: t.label, detail: disguised ? `Looks identical to ${t.label} once lookalike characters are read as letters.` : `Same name as ${t.label}.` });
      continue;
    }
    // Reordered words (needs a multi-word brand)
    if (t.words.length > 1 && t.words.every((w) => candWords.includes(w))) {
      consider({ s1: 20, s2, kind: 'reordered', target: t.label, detail: `Uses the words of ${t.label} in a different order.` });
    }
    if (candSk.includes(t.sk)) {
      const rest = candSk.replace(t.sk, ' ').trim();
      consider({ s1: 15, s2, kind: 'contains', target: t.label, detail: `Contains ${t.label}${rest ? ' plus "' + rest.replace(/\s+/g, ' … ') + '"' : ''}.` });
      continue;
    }
    const win = bestWindow(candSk, t.sk);
    const allowed = t.sk.length >= 8 ? 2 : t.sk.length >= 5 ? 1 : 0;
    if (win.dist <= allowed) {
      const s1 = win.dist === 1 ? 25 : 20;
      const seen = candSk.slice(win.at, win.at + win.len);
      consider({ s1, s2, kind: 'lookalike', target: t.label, detail: `"${seen}" is ${win.dist} edit${win.dist > 1 ? 's' : ''} from ${t.label}${candSk.length > win.len + 1 ? ', with extra words' : ''}.` });
      continue;
    }
    // A distinctive single word of a multi-word brand ("Northstar" in "Northstar Labs")
    for (const w of t.words.length > 1 ? t.words : []) {
      if (w.length < 6 || brand.generic.has(w)) continue;
      const ww = bestWindow(candSk, w);
      const disguisedW = subs.length > 0 && !candPl.includes(w) && ww.dist === 0;
      if (ww.dist === 0) consider({ s1: 12, s2: disguisedW ? 10 : 0, kind: 'word', target: t.label, detail: `Uses the brand word "${w}".` });
      else if (ww.dist === 1 && w.length >= 7) consider({ s1: 20, s2: 0, kind: 'word-lookalike', target: t.label, detail: `"${candSk.slice(ww.at, ww.at + ww.len)}" is 1 edit from the brand word "${w}".` });
    }
    if (t.strict) continue; // official app names: exact, contained or near-identical only
    const ratio = 1 - editDistance(candSk, t.sk) / Math.max(candSk.length, t.sk.length);
    if (ratio >= 0.6) consider({ s1: Math.round((ratio - 0.6) / 0.4 * 8), s2, kind: 'weak', target: t.label, detail: `Loosely resembles ${t.label} (${Math.round(ratio * 100)}% similar).` });
  }
  // Lookalike characters elsewhere in a name that already uses the brand ("acme_supp0rt")
  if (best.s1 > 0 && !best.s2 && subs.some((x) => /[0-9@$!|]/.test(x.ch) || x.ch.charCodeAt(0) > 127)) {
    best = { ...best, s2: 5, partialDisguise: true };
  }
  best.substitutions = best.s2 ? subs : [];
  return best;
}

/* ------------------------------------------------------------------ */
/* Phrase lists                                                        */
/* ------------------------------------------------------------------ */

const CLAIM_RE = [
  [/\b(official|offical|0fficial|officia1)\b/i, 'calls itself official'],
  [/\b(second|2nd|backup|back-?up|new|alternate|alt)\s+(account|acc|page|profile|id)\b/i, 'claims to be a second / backup account'],
  [/\bold\s+(account|acc|page|id)\b.*\b(hacked|disabled|deleted|banned|suspended)\b/i, 'says the old account was hacked or disabled'],
  [/\b(customer\s*(care|support|service)|help\s*desk|helpdesk|support\s*team|official\s*support)\b/i, 'offers customer support'],
  [/\bauthori[sz]ed\s+(partner|reseller|dealer|agent|seller|distributor)\b/i, 'claims to be an authorised partner'],
  [/\b(managed|run|owned)\s+by\s+(the\s+)?(official|brand|company)\b/i, 'claims to be run by the brand']
];
const SCAM_RE = [
  [/\bgive ?aways?\b|\bwinners?\b|\bclaim\s+(your\s+)?(prize|reward|gift)/i, 'prize or giveaway bait'],
  [/\b(delivery|processing|shipping|registration|activation)\s+(fee|charge)/i, 'asks for a fee'],
  [/\bverify\s+(your\s+)?(account|login|identity|details)|\blog ?in\s+(here|now|to)|\bpassword\b|\botp\b|\bkyc\b/i, 'asks for login or verification'],
  [/\brefunds?\b|\bcompensation\b|\bchargeback/i, 'refund bait'],
  [/\b(invest(ment)?|crypto|bitcoin|btc|usdt|forex|double\s+your|guaranteed\s+(profit|returns))\b/i, 'investment or crypto bait'],
  [/\b(dm|message|inbox)\s+(us|me)\b|\bwhats?app\b|\bwa\.me\b|\btelegram\b|\bt\.me\b/i, 'moves the conversation off-platform'],
  [/\b(free\s+followers|limited\s+(time\s+)?offer|act\s+now|urgent(ly)?)\b/i, 'urgency or freebie wording']
];
const DISCLAIMER_RE = /\b(fan\s*(page|account|club|made|art)|fanpage|fanmade|fan-made|parody|unofficial|not\s+(an?\s+)?official|not\s+affiliated|no\s+affiliation|tribute|satire)\b/i;
const CREDIT_RE = /\b(repost(ed)?|regram|credit(s)?\s*(to|:)?|via\s+@|📸\s*@|source\s*:)/i;
const VERIFIED_FAKE_RE = /[✓✔☑✅]|\bverified\b/i;
const CONTACT_RE = [
  [/\+?\d[\d\s().-]{8,}\d/, 'phone number'],
  [/\bwa\.me\/|\bwhats?app\b/i, 'WhatsApp'],
  [/\bt\.me\/|\btelegram\b/i, 'Telegram'],
  [/[a-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|proton|icloud)\.[a-z.]+/i, 'personal email address']
];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 'cutt.ly', 'rb.gy', 'is.gd', 'ow.ly', 't.co', 'shorturl.at', 'tiny.cc', 'rebrand.ly'];

function matchAll(list, text) {
  return list.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/* ------------------------------------------------------------------ */
/* Scoring helpers                                                     */
/* ------------------------------------------------------------------ */

export function severity(score) {
  return score >= 75 ? 'High' : score >= 45 ? 'Medium' : 'Low';
}

function check(id, label, max, points = 0, status = 'checked', evidence = []) {
  return { id, label, max, points, status, evidence: Array.isArray(evidence) ? evidence : [evidence] };
}

function finalise(checks, { cap74, floor75, notes = [] }) {
  const get = (id) => checks.find((c) => c.id === id)?.points || 0;
  let raw = checks.reduce((s, c) => s + c.points, 0);
  raw = Math.max(0, Math.min(100, raw));
  let score = raw;
  const guardrails = [...notes];
  if (cap74 && score > 74) { score = 74; guardrails.push('Capped at 74: the name matches but nothing else supports it (guardrail 2).'); }
  if (floor75 && score < 75) { score = 75; guardrails.push('Raised to 75: look-alike name plus two strong signals (guardrail 3).'); }
  const possible = checks.filter((c) => c.max > 0).reduce((s, c) => s + c.max, 0);
  const unchecked = checks.filter((c) => c.max > 0 && c.status === 'unavailable').reduce((s, c) => s + c.max, 0);
  const confidence = Math.round(100 * (possible - unchecked) / possible);
  return { score, rawScore: raw, severity: severity(score), confidence, guardrails, get };
}

/* ------------------------------------------------------------------ */
/* Social monitoring: S1–S10                                           */
/* ------------------------------------------------------------------ */

/**
 * Score one Instagram profile.
 * profile: normalised profile from the server (username, fullName, bio, externalUrl, bioLinks, isVerified,
 *          followers, mediaCount, id, posts[{caption, takenAt, thumbHash}], pfpHash)
 * ctx: { brand (compiled), logoHashes: [{label, hash}], officialPosts: [{handle, caption, takenAt, thumbHash, shortcode}] , now }
 */
export function scoreSocial(profile, brand, ctx = {}) {
  const handle = String(profile.username || '').toLowerCase();
  const now = ctx.now || Date.now();
  if (brand.officialHandles.has(handle) || (profile.id && brand.officialIds.has(String(profile.id)))) {
    return { excluded: true, reason: 'official', score: 0, severity: 'Official', checks: [], confidence: 100, guardrails: ['On the official registry: never scored.'] };
  }
  if (brand.partners.has(handle)) {
    return { excluded: true, reason: 'partner', score: 0, severity: 'Partner', checks: [], confidence: 100, guardrails: ['Approved partner: never scored.'] };
  }

  const bio = String(profile.bio || '');
  const captions = (profile.posts || []).map((p) => p.caption || '').join('\n');
  const allText = [profile.fullName, bio].join('\n');
  const everything = [allText, captions].join('\n');
  const checks = [];
  // Limited profiles (public page only): bio is partial or missing, links and posts are not visible.
  const lim = !!profile.limited;
  const limNote = 'Not available: only the public profile page could be read (no full bio, links or posts).';

  // S1 + S2 — name and lookalike characters (username and display name)
  const byHandle = nameMatch(profile.username, brand);
  const byName = nameMatch(profile.fullName, brand);
  const nm = (byHandle.s1 + byHandle.s2 >= byName.s1 + byName.s2) ? { ...byHandle, field: 'username' } : { ...byName, field: 'display name' };
  let s1 = nm.s1;
  const keywordHit = brand.keywords.some((k) => plain(k).length >= 3 && plain(everything).includes(plain(k)));
  checks.push(check('S1', 'Name similarity', 25, s1, 'checked', s1 ? `${nm.field === 'username' ? '@' + profile.username : '"' + profile.fullName + '"'}: ${nm.detail}` : 'Username and display name do not resemble the brand.'));
  checks.push(check('S2', 'Lookalike characters', 10, nm.s2, 'checked', nm.s2 ? `${nm.partialDisguise ? 'Lookalike characters elsewhere in the name' : 'Brand name disguised'}: ${nm.substitutions.map((s) => `"${s.ch}" for "${s.as}"`).join(', ')}` : 'No lookalike characters used to disguise the name.'));

  // S3 — account age
  let s3 = 0; const s3e = []; let s3status = 'checked';
  if (profile.id && brand.officialMaxId && /^\d+$/.test(String(profile.id))) {
    if (BigInt(profile.id) > BigInt(brand.officialMaxId)) { s3 += 5; s3e.push('Account ID is newer than every official account (created later).'); }
    else s3e.push('Account ID is older than an official account.');
  } else if (!profile.id) { s3status = 'unavailable'; }
  const times = (profile.posts || []).map((p) => p.takenAt).filter(Boolean);
  if (profile.mediaCount != null && profile.mediaCount <= 12 && times.length) {
    const first = Math.min(...times);
    const days = Math.floor((now - first) / 864e5);
    if (days <= 90) { s3 += 3; s3e.push(`First post ${days} day${days === 1 ? '' : 's'} ago; only ${profile.mediaCount} posts.`); }
    else s3e.push(`First post ${days} days ago.`);
  } else if (profile.mediaCount === 0) { s3 += 3; s3e.push('No posts yet.'); }
  if (!s3e.length && s3status === 'checked') s3e.push('No age signal.');
  const brandLinked = s1 > 0 || nm.s2 > 0 || keywordHit;
  if (s3 && !brandLinked) { s3e.push('Not counted: nothing links this account to the brand.'); s3 = 0; }
  checks.push(check('S3', 'Account age', 8, Math.min(8, s3), s3status === 'unavailable' && !s3 ? 'unavailable' : 'checked', s3e.length ? s3e : 'Account ID not available.'));

  // S4 — bio and contact details
  let s4 = 0; const s4e = [];
  if (brand.keywords.some((k) => plain(k).length >= 3 && plain(allText).includes(plain(k)))) { s4 += 3; s4e.push('Bio or display name uses brand keywords.'); }
  if (/\b(support|help|care|service|assist|queries|complaints?)\b/i.test(allText)) { s4 += 2; s4e.push('Offers help or support.'); }
  const contacts = matchAll(CONTACT_RE, allText);
  if (contacts.length) { s4 += 2; s4e.push('Contact route not on the brand profile: ' + contacts.join(', ') + '.'); }
  checks.push(check('S4', 'Bio and contact details', 7, Math.min(7, s4), lim && !s4 ? 'unavailable' : 'checked', s4e.length ? s4e : lim ? limNote : 'Nothing brand-related in the bio.'));

  // S5 — profile picture vs logo / official pictures
  let s5 = 0, s5status = 'checked', s5e = 'Profile picture does not match the logo or official pictures.';
  if (!profile.pfpHash || !(ctx.logoHashes || []).length) { s5status = 'unavailable'; s5e = !profile.pfpHash ? 'Profile picture could not be loaded.' : 'No logo or official picture to compare against.'; }
  else {
    const best = ctx.logoHashes.map((l) => ({ ...l, d: hamming(profile.pfpHash, l.hash) })).sort((a, b) => a.d - b.d)[0];
    if (best.d <= 8) { s5 = 15; s5e = `Profile picture matches ${best.label} (fingerprint distance ${best.d}/64).`; }
    else if (best.d <= 14) { s5 = 8; s5e = `Profile picture resembles ${best.label} (distance ${best.d}/64).`; }
    else s5e = `Closest match ${best.label}: distance ${best.d}/64 (not similar).`;
  }
  checks.push(check('S5', 'Profile picture and logo', 15, s5, s5status, s5e));

  // S7 — false official claims (computed before S6, which uses it)
  const claims = matchAll(CLAIM_RE, allText);
  const mentionsBrand = s1 > 0 || keywordHit;
  let s7 = 0, s7e = 'No official or support claims.';
  if (claims.length && mentionsBrand) { s7 = 20; s7e = `Claims: ${claims.join('; ')}. Not on the official registry.`; }
  else if (claims.length) { s7 = 6; s7e = `Claims: ${claims.join('; ')} (no brand mention).`; }

  // S6 — verification badge
  let s6 = 0, s6e = profile.isVerified ? 'Verified badge, not on the official registry.' : 'Not verified.';
  if (profile.isVerified && (s1 >= 15 || s7 > 0)) { s6 = 10; s6e = 'Verified badge on an account that is not on the official registry but uses the brand: possible bought badge.'; }
  else if (!profile.isVerified && VERIFIED_FAKE_RE.test(allText)) { s6 = 6; s6e = 'Uses a check mark or "verified" in the name or bio without a real badge.'; }
  checks.push(check('S6', 'Verification badge', 10, s6, profile.isVerified == null ? 'unavailable' : 'checked', s6e));
  checks.push(check('S7', 'False official claims', 20, s7, lim && !s7 ? 'unavailable' : 'checked', lim && !s7 ? limNote : s7e));

  // S8 — scam wording and links
  let s8 = 0; const s8e = [];
  const scam = matchAll(SCAM_RE, everything);
  if (scam.length) { s8 += scam.length >= 2 ? 12 : 8; s8e.push('Wording: ' + scam.join('; ') + '.'); }
  const links = [...new Set([profile.externalUrl, ...(profile.bioLinks || [])].filter(Boolean))];
  for (const link of links) {
    const host = hostOf(link);
    if (!host) continue;
    if (brand.domains.includes(host)) { s8e.push(`Links to the official site ${host}.`); continue; }
    if (SHORTENERS.includes(host)) { s8 += 3; s8e.push(`Hides its destination behind ${host}.`); continue; }
    const hostCore = host.split('.').slice(0, -1).join('.');
    const lookalike = brand.domains.some((d) => { const core = d.split('.').slice(0, -1).join('.'); const w = bestWindow(skeleton(hostCore), skeleton(core)); return w.dist <= 1; }) ||
      brand.nameSkeletons.some((n) => n.sk.length >= 4 && bestWindow(skeleton(hostCore), n.sk).dist <= 1);
    if (lookalike) { s8 += 8; s8e.push(`Links to look-alike website ${host}.`); }
  }
  checks.push(check('S8', 'Scam wording and links', 15, Math.min(15, s8), lim && !s8 ? 'unavailable' : 'checked', s8e.length ? s8e : lim ? limNote : 'No scam wording or suspicious links.'));

  // S9 — copied content from official posts
  let copies = []; let s9status = 'checked';
  const official = ctx.officialPosts || brand.officialPosts || [];
  if (!official.length || (lim && !(profile.posts || []).length)) s9status = 'unavailable';
  for (const p of profile.posts || []) {
    for (const o of official) {
      const later = !o.takenAt || !p.takenAt || p.takenAt > o.takenAt;
      if (!later) continue;
      const cap = (p.caption || '').trim();
      if (cap.length >= 30 && o.caption && jaccard(shingles(cap), shingles(o.caption)) >= 0.6) { copies.push({ post: p, of: o, kind: 'caption' }); break; }
      if (p.thumbHash && o.thumbHash && hamming(p.thumbHash, o.thumbHash) <= 6) { copies.push({ post: p, of: o, kind: 'image' }); break; }
    }
  }
  const credited = copies.length && CREDIT_RE.test(copies.map((c) => c.post.caption || '').join(' '));
  const s9 = copies.length >= 2 ? 10 : copies.length === 1 ? 6 : 0;
  checks.push(check('S9', 'Copied content', 10, s9, s9status, s9status === 'unavailable' ? (official.length ? 'Not available: this account\'s posts could not be read.' : 'No official posts to compare against.') : copies.length ? copies.map((c) => `Post ${c.post.shortcode || ''} copies the ${c.kind} of @${c.of.handle}'s post ${c.of.shortcode || ''}${c.of.takenAt ? ' (posted later)' : ''}.`) : 'No posts copied from official accounts.'));

  // S10 — context
  let s10 = 0; const s10e = [];
  const disclaimer = DISCLAIMER_RE.test([profile.username, allText].join(' '));
  if (disclaimer) { if (s5 > 0) s10e.push('Fan or parody label, but it also uses the logo: no reduction.'); else { s10 -= 20; s10e.push('Labelled as fan, parody or unofficial.'); } }
  if (credited) { s10 -= 5; s10e.push('Copied posts credit the original.'); }
  if (s1 >= 20 && profile.followers != null && profile.followers < 500) { s10 += 5; s10e.push(`Only ${profile.followers} followers for a close brand match.`); }
  if (profile.isPrivate) s10e.push('Private account: posts not visible.');
  checks.push(check('S10', 'Context', 5, s10, 'checked', s10e.length ? s10e : 'No fan label or other context.'));

  // Guardrail 4 — dictionary-word brand
  const notes = [];
  if (brand.isCommonWord && s1 > 10 && !keywordHit && s5 === 0) {
    const c = checks.find((x) => x.id === 'S1'); c.points = 10; notes.push('Name points limited to 10: the brand is a common word and nothing else ties this account to it (guardrail 4).');
    s1 = 10;
  }
  const supporting = ['S4', 'S5', 'S6', 'S7', 'S8', 'S9'].some((id) => (checks.find((c) => c.id === id)?.points || 0) > 0);
  const strong = [s5 > 0, s7 >= 20, s8 > 0].filter(Boolean).length;
  const res = finalise(checks, { cap74: !supporting, floor75: (s1 >= 20 || nm.s2 > 0) && strong >= 2, notes });
  return { excluded: false, score: res.score, rawScore: res.rawScore, severity: res.severity, confidence: res.confidence, guardrails: res.guardrails, checks, related: s1 > 0 || nm.s2 > 0 || keywordHit || s5 > 0, nameMatch: nm, copies };
}

/* ------------------------------------------------------------------ */
/* App store monitoring: A1–A9                                         */
/* ------------------------------------------------------------------ */

/**
 * app: { trackId, name, bundleId, seller, artistId, artistName, sellerUrl, description, releaseDate, genre, ratingCount, iconHash }
 * ctx: { logoHashes: [{label, hash}] }
 */
export function scoreApp(app, brand, ctx = {}) {
  const tid = String(app.trackId || '');
  const bid = String(app.bundleId || '').toLowerCase();
  if (brand.trackIds.has(tid) || brand.bundleIds.has(bid)) return { excluded: true, reason: 'official', score: 0, severity: 'Official', checks: [], confidence: 100, guardrails: ['On the official registry: never scored.'] };
  if (app.artistId && brand.developerIds.has(String(app.artistId))) return { excluded: true, reason: 'unlisted-official', score: 0, severity: 'Unlisted official?', checks: [], confidence: 100, guardrails: ['Published by the official developer account but not listed in the brand profile. Confirm and add it.'] };

  const checks = [];
  const desc = String(app.description || '');

  // A1 — app name
  let nm = nameMatch(app.name, brand, { filler: APP_FILLER });
  // Also compare with the official apps' own names ("Northstar Secure")
  const appNames = [...new Set([...(brand.raw.apps || []).map((x) => x.label), ...(brand.officialApps || []).map((o) => o.name)].filter(Boolean))];
  if (appNames.length) {
    // Only the product-name part counts ("Nike SNKRS" from "Nike SNKRS: Sneakers & Apparel"): the subtitle is
    // generic shop wording that legitimate competitors share, so it must not make them look like impersonators.
    const core = (n) => String(n).split(/\s*[:|–—]\s*|\s+-\s+/)[0].trim();
    const cores = [...new Set(appNames.map(core))].filter((n) => skeleton(n).length >= 4 && !brand.nameSkeletons.some((b) => b.sk === skeleton(n)));
    const asBrand = { ...brand, nameSkeletons: cores.map((n) => ({ name: n, sk: skeleton(n), pl: plain(n), words: [], strict: true })), officialSkeletons: [] };
    const nm2 = nameMatch(app.name, asBrand, { filler: APP_FILLER.filter((f) => f !== 'official') });
    if (nm2.s1 + nm2.s2 > nm.s1 + nm.s2) nm = { ...nm2, detail: nm2.detail.replace(/^Same name as /, 'Same name as the official app ') };
  }
  const a1 = Math.min(25, nm.s1 + (nm.s2 ? 5 : 0));
  checks.push(check('A1', 'App name similarity', 25, a1, 'checked', a1 ? `"${app.name}": ${nm.detail}` : 'App name does not resemble the brand.'));

  // A3 — publisher (computed early; A2 needs to know it)
  const officialPub = brand.publishers.some((p) => plain(p) && plain(p) === plain(app.seller || app.artistName));
  const pubMatch = nameMatch(app.seller || app.artistName, brand);
  let a3 = 0; const a3e = [];
  if (officialPub) a3e.push(`Published by "${app.seller || app.artistName}", an official publisher name (developer ID not confirmed).`);
  else if (pubMatch.s1 >= 15) { a3 = 15; a3e.push(`Developer "${app.seller || app.artistName}" imitates the brand but is not an official developer.`); }
  else { a3 = 10; a3e.push(`Developer "${app.seller || app.artistName || 'unknown'}" is not an official publisher.`); }
  const sellerHost = hostOf(app.sellerUrl || '');
  if (sellerHost && brand.domains.length && !brand.domains.includes(sellerHost)) a3e.push(`Developer website ${sellerHost} is not an official domain.`);

  // A2 — bundle ID
  let a2 = 0, a2e = 'Bundle ID does not use the brand.';
  const officialPrefix = [...brand.bundleIds].find((b) => bid.startsWith(b + '.'));
  if (officialPrefix && !officialPub) { a2 = 15; a2e = `"${app.bundleId}" extends the official ID ${officialPrefix}.`; }
  else if (!officialPub) {
    const parts = bid.split('.').filter((p) => !['com', 'net', 'org', 'io', 'app', 'co', 'in', 'ios'].includes(p));
    for (const n of brand.nameSkeletons) {
      if (n.sk.length < 4) continue;
      const hit = parts.find((p) => skeleton(p).includes(n.sk) || bestWindow(skeleton(p), n.sk).dist <= 1);
      if (hit) { a2 = 10; a2e = `Bundle ID segment "${hit}" uses or imitates "${n.name}".`; break; }
    }
  }
  checks.push(check('A2', 'Bundle ID impersonation', 15, a2, 'checked', a2e));
  checks.push(check('A3', 'Publisher mismatch', 15, a3, 'checked', a3e));

  // A4 — icon
  let a4 = 0, a4status = 'checked', a4e = 'Icon does not match the logo or official icons.';
  if (!app.iconHash || !(ctx.logoHashes || []).length) { a4status = 'unavailable'; a4e = !app.iconHash ? 'Icon could not be loaded.' : 'No logo or official icon to compare against.'; }
  else {
    const best = ctx.logoHashes.map((l) => ({ ...l, d: hamming(app.iconHash, l.hash) })).sort((a, b) => a.d - b.d)[0];
    if (best.d <= 8) { a4 = 15; a4e = `Icon matches ${best.label} (fingerprint distance ${best.d}/64).`; }
    else if (best.d <= 14) { a4 = 8; a4e = `Icon resembles ${best.label} (distance ${best.d}/64).`; }
    else a4e = `Closest match ${best.label}: distance ${best.d}/64 (not similar).`;
  }
  checks.push(check('A4', 'Icon similarity', 15, a4, a4status, a4e));

  // A5 — description and branding
  let a5 = 0; const a5e = [];
  const offDescs = (brand.officialApps || []).filter((o) => o.description);
  if (offDescs.length) {
    const sim = Math.max(...offDescs.map((o) => jaccard(shingles(desc), shingles(o.description))));
    if (sim >= 0.4) { a5 += 10; a5e.push(`Description is ${Math.round(sim * 100)}% the same as the official app's.`); }
  }
  const claims = matchAll(CLAIM_RE, desc);
  const kwCount = brand.keywords.filter((k) => plain(k).length >= 3 && plain(desc).includes(plain(k))).length;
  if (claims.length && (kwCount || a1)) { a5 += 6; a5e.push('Claims: ' + claims.join('; ') + '.'); }
  if (kwCount >= 1) { a5 += 3; a5e.push(`Mentions ${kwCount} brand keyword${kwCount > 1 ? 's' : ''}.`); }
  checks.push(check('A5', 'Description and branding', 10, Math.min(10, a5), 'checked', a5e.length ? a5e : 'Description does not resemble the brand.'));

  // A6 — risky behaviour
  const scam = matchAll(SCAM_RE, desc);
  const a6 = scam.length >= 2 ? 10 : scam.length ? 5 : 0;
  checks.push(check('A6', 'Risky behaviour', 10, a6, 'checked', scam.length ? 'Wording: ' + scam.join('; ') + '.' : 'No credential, payment or crypto bait.'));

  // A7 — release date and reputation
  let a7 = 0; const a7e = [];
  const offDates = (brand.officialApps || []).map((o) => Date.parse(o.releaseDate)).filter(Boolean);
  const rel = Date.parse(app.releaseDate);
  if (rel && offDates.length) {
    if (rel > Math.min(...offDates)) { a7 += 2; a7e.push('Released after the official app.'); if ((app.ratingCount ?? 0) < 50) { a7 += 3; a7e.push(`Only ${app.ratingCount ?? 0} ratings.`); } }
    else a7e.push('Released before the official app.');
  }
  checks.push(check('A7', 'Release date and reputation', 5, a7, offDates.length ? 'checked' : 'unavailable', a7e.length ? a7e : 'Official release date not known.'));

  // A8 — category
  const sameGenre = (brand.officialApps || []).some((o) => o.genre && o.genre === app.genre);
  checks.push(check('A8', 'Category match', 3, sameGenre ? 3 : 0, (brand.officialApps || []).length ? 'checked' : 'unavailable', sameGenre ? `Same category as the official app (${app.genre}).` : `Category: ${app.genre || 'unknown'}.`));

  // A9 — disclaimers
  const disc = DISCLAIMER_RE.test(app.name + ' ' + desc);
  const a9 = disc && a4 === 0 ? -15 : 0;
  checks.push(check('A9', 'Disclaimer', 0, a9, 'checked', disc ? (a9 ? 'Says it is unofficial or fan-made.' : 'Says unofficial, but the icon matches: no reduction.') : 'No disclaimer.'));

  const related = a1 > 0 || a2 > 0 || a4 > 0 || kwCount > 0;
  const supporting = ['A2', 'A4', 'A5', 'A6'].some((id) => (checks.find((c) => c.id === id)?.points || 0) > 0) || a3 === 15;
  const res = finalise(checks, { cap74: !supporting, floor75: a2 === 15 });
  return { excluded: false, score: res.score, rawScore: res.rawScore, severity: res.severity, confidence: res.confidence, guardrails: res.guardrails, checks, related, nameMatch: nm };
}

/* ------------------------------------------------------------------ */
/* Name variant generator (proactive search)                           */
/* ------------------------------------------------------------------ */

const SUBS_OUT = { o: '0', l: '1', i: '1', e: '3', a: '4', s: '5', t: '7' };

export function generateVariants(name, { max = 40 } = {}) {
  const base = plain(name);
  const parts = words(name).map(plain).filter(Boolean);
  const out = new Map();
  const add = (v, technique) => { v = v.toLowerCase(); if (v && v !== base && /^[a-z0-9._]{3,30}$/.test(v) && !out.has(v)) out.set(v, technique); };
  if (!base || base.length < 3) return [];
  for (let i = 0; i < base.length - 1; i++) if (base[i] !== base[i + 1]) add(base.slice(0, i) + base[i + 1] + base[i] + base.slice(i + 2), 'Swapped letters');
  for (let i = 0; i < base.length; i++) add(base.slice(0, i + 1) + base[i] + base.slice(i + 1), 'Doubled letter');
  for (let i = 1; i < base.length; i++) add(base.slice(0, i) + base.slice(i + 1), 'Missing letter');
  for (let i = 0; i < base.length; i++) if (SUBS_OUT[base[i]]) add(base.slice(0, i) + SUBS_OUT[base[i]] + base.slice(i + 1), `Lookalike "${SUBS_OUT[base[i]]}" for "${base[i]}"`);
  if (parts.length > 1) {
    add(parts.join('_'), 'Underscore between words'); add(parts.join('.'), 'Dot between words');
    add([...parts].reverse().join(''), 'Words reordered'); add([...parts].reverse().join('_'), 'Words reordered');
  }
  for (const w of ['support', 'help', 'official', 'care', 'giveaway', 'india', 'team', 'hq']) { add(base + '_' + w, `Added "${w}"`); add(base + w, `Added "${w}"`); add(base + '.' + w, `Added "${w}"`); }
  for (const w of ['the', 'real', 'official']) add(w + base, `Added "${w}"`);
  // Priority: the techniques scammers use most first
  const order = ['Added "support"', 'Added "official"', 'Added "help"', 'Lookalike', 'Doubled letter', 'Underscore between words', 'Dot between words', 'Missing letter', 'Swapped letters'];
  const rank = (t) => { const i = order.findIndex((o) => t.startsWith(o)); return i < 0 ? order.length : i; };
  return [...out.entries()].map(([handle, technique]) => ({ handle, technique })).sort((a, b) => rank(a.technique) - rank(b.technique)).slice(0, max);
}
