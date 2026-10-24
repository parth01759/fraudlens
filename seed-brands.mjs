// Adds Northstar Constructions and Northstar Transports to a running FraudLens server.
//   1. Start the app:   node server.js
//   2. In a 2nd shell:  node seed-brands.mjs          (optional: BASE=http://localhost:4321)
// Safe to re-run: brands that already exist by name are skipped.

const BASE = process.env.BASE || 'http://localhost:4321';
const MAX_BRANDS = 3; // matches MAX_BRANDS in server.js

const NEW_BRANDS = [
  { name: 'Northstar Constructions', aliases: ['Northstar Construction', 'Northstar Constructions Ltd'], keywords: ['northstar constructions'], genericWords: ['constructions', 'construction'] },
  { name: 'Northstar Transports', aliases: ['Northstar Transport', 'Northstar Transports Ltd'], keywords: ['northstar transports'], genericWords: ['transports', 'transport'] }
];

const profile = (b) => ({
  name: b.name, aliases: b.aliases, keywords: b.keywords, genericWords: b.genericWords,
  isCommonWord: false, domains: [], instagram: [], partners: [], apps: [], publishers: [],
  logo: '', logoHash: '', country: 'in'
});

async function api(method, path, body, brandId) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(brandId ? { 'x-brand-id': brandId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'failed'}`);
  return data;
}
const getBrands = async () => (await api('GET', '/api/state')).brands;

let brands = await getBrands();
const originalActive = brands.find((b) => b.active)?.id;

for (const target of NEW_BRANDS) {
  if (brands.some((b) => b.name.toLowerCase() === target.name.toLowerCase())) { console.log(`skip  ${target.name} (already exists)`); continue; }

  let slot = brands.find((b) => !b.name); // reuse an empty "New brand" placeholder first
  if (slot) {
    brands = (await api('POST', '/api/brands/switch', { id: slot.id })).brands;
  } else if (brands.length < MAX_BRANDS) {
    brands = (await api('POST', '/api/brands')).brands; // creates a new brand and makes it active
    slot = brands.find((b) => b.active);
  } else {
    console.error(`FAIL  ${target.name}: all ${MAX_BRANDS} brand slots are used by named brands. Delete one first.`);
    continue;
  }
  await api('PUT', '/api/brand', profile(target), slot.id);
  brands = await getBrands();
  console.log(`added ${target.name} (${slot.id})`);
}

if (originalActive && brands.some((b) => b.id === originalActive)) await api('POST', '/api/brands/switch', { id: originalActive });
console.log('\nBrands now:', (await getBrands()).map((b) => `${b.name || '(unnamed)'}${b.active ? ' *' : ''}`).join(' | '));
