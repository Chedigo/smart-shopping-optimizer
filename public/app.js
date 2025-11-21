// ============================
// Smart Shopping Optimizer — app.js
// ============================

// ————— Grunnstatus/manifest/SW indikasjon —————
const statusEl = document.getElementById('status');
const swStatusEl = document.getElementById('swStatus');
const manifestStatusEl = document.getElementById('manifestStatus');
const MIN_COVERAGE = 0.60;
const COVERAGE_WEIGHT = 0.05;

// --- Kjeder (kode -> visningsnavn) samsvarer med Kassalapp 'group' ---
const CHAIN_DEFS = [
  { code: 'ALLTIMAT',      label: 'AlltiMat' },
  { code: 'BUNNPRIS',      label: 'Bunnpris' },
  { code: 'COOP_EXTRA',    label: 'Extra' },
  { code: 'COOP_OBS',      label: 'Obs' },
  { code: 'COOP_OBS_BYGG', label: 'Obs Bygg' },
  { code: 'COOP_MEGA',     label: 'Coop Mega' },
  { code: 'COOP_MARKED',   label: 'Coop Marked' },
  { code: 'COOP_PRIX',     label: 'Coop Prix' },
  { code: 'EUROPRIS_NO',   label: 'Europris' },
  { code: 'FUDI',          label: 'FUDI' },
  { code: 'GIGABOKS',      label: 'Gigaboks' },
  { code: 'HAVARISTEN',    label: 'Havaristen' },
  { code: 'JOKER_NO',      label: 'Joker' },
  { code: 'KIWI',          label: 'KIWI' },
  { code: 'MATKROKEN',     label: 'Matkroken' },
  { code: 'MENY_NO',       label: 'MENY' },
  { code: 'NAERBUTIKKEN',  label: 'Nærbutikken' },
  { code: 'REMA_1000',     label: 'REMA 1000' },
  { code: 'SPAR_NO',       label: 'SPAR' },
];
// Lagringsnøkler
const LS_PREF_ENABLED = 'sso:prefChainsEnabled';
const LS_PREF_CHAINS  = 'sso:prefChains';

// Manifest/SW status
fetch('./manifest.webmanifest')
  .then(r => { manifestStatusEl.textContent = r.ok ? 'OK' : 'mangler'; })
  .catch(() => { manifestStatusEl.textContent = 'mangler'; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(() => { swStatusEl.textContent = 'registrert'; })
    .catch(() => { swStatusEl.textContent = 'feilet'; });
} else {
  swStatusEl.textContent = 'ikke støttet';
}

// ————— Install-knapp —————
let deferredPrompt;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});
installBtn?.addEventListener('click', async () => {
  installBtn.hidden = true;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (statusEl) statusEl.textContent = outcome === 'accepted' ? 'Installert (akseptert)' : 'Avbrutt';
  deferredPrompt = null;
});

// ————— DOM-referanser —————
const searchInput = document.getElementById('searchInput');
const suggestions = document.getElementById('suggestions');
const listEl = document.getElementById('list');
const clearListBtn = document.getElementById('clearListBtn');
const filtersPanel = document.getElementById('searchFiltersPanel');
const filterCategoryInput = document.getElementById('filterCategory');
const filterSubcategoryInput = document.getElementById('filterSubcategory');
const filterBrandInput = document.getElementById('filterBrand');
const filterLactoseFreeInput = document.getElementById('filterLactoseFree');
const filterFatMinInput = document.getElementById('filterFatMin');
const filterFatMaxInput = document.getElementById('filterFatMax');
const filterSizeMinInput = document.getElementById('filterSizeMin');
const filterSizeMaxInput = document.getElementById('filterSizeMax');
const filterSizeUnitSelect = document.getElementById('filterSizeUnit');
const filterResetBtn = document.getElementById('filterResetBtn');
const filtersSummary = filtersPanel ? filtersPanel.querySelector('summary') : null;

const REMOTE_SUGGESTION_LIMIT = 12;
const FILTER_STORAGE_KEY = 'sso:searchFilters';
const DEFAULT_FILTERS = {
  category: '',
  subcategory: '',
  brand: '',
  lactoseFree: false,
  fatMin: null,
  fatMax: null,
  sizeMin: null,
  sizeMax: null,
  sizeUnit: 'auto',
  limit: REMOTE_SUGGESTION_LIMIT
};

let searchFilters = loadStoredFilters();
applyFiltersToDom(searchFilters);
updateFiltersSummaryLabel(searchFilters);

// Scope-bryter (radioer)
const scopeInputs = document.querySelectorAll('input[name="scope"]');
function getCurrentScope() {
  const checked = document.querySelector('input[name="scope"]:checked');
  return (checked?.value) || 'all';
}
{
  const stored = localStorage.getItem('sso:scope');
  if (stored) {
    const m = Array.from(scopeInputs).find(x => x.value === stored);
    if (m) m.checked = true;
  }
}
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t && t.name === 'scope') {
    localStorage.setItem('sso:scope', t.value);
    updateSuggestions();
    renderList();
    debouncedUpdateSingleStoreSummary();
  }
});

// ————— Tilstand —————
let products = [];
let list = loadList();

// Cache av tilbud per EAN+scope
const pricesByKey = new Map();
const cacheKey = (ean, scope) => `${ean}|${scope}`;

// ————— Hjelpere —————
const cleanEAN = (s) => String(s || '').replace(/\D/g, '');
function sanitizeQuery(q) {
  return String(q || '')
    .normalize('NFKC')
    .replace(/[^0-9A-Za-z æøåÆØÅ\-\.]/g, ' ')
    .trim()
    .slice(0, 40);
}
function uniqueBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of arr || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key); out.push(item);
  }
  return out;
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeFilters(raw) {
  const out = { ...DEFAULT_FILTERS };
  if (!raw || typeof raw !== 'object') return { ...out };
  if (typeof raw.category === 'string') out.category = raw.category.trim();
  if (typeof raw.subcategory === 'string') out.subcategory = raw.subcategory.trim();
  if (typeof raw.brand === 'string') out.brand = raw.brand.trim();
  if (typeof raw.lactoseFree === 'boolean') out.lactoseFree = raw.lactoseFree;
  else if (raw.lactoseFree === 'true') out.lactoseFree = true;
  const fatMin = coerceNumber(raw.fatMin);
  const fatMax = coerceNumber(raw.fatMax);
  out.fatMin = fatMin;
  out.fatMax = fatMax;
  out.sizeMin = coerceNumber(raw.sizeMin);
  out.sizeMax = coerceNumber(raw.sizeMax);
  const unit = String(raw.sizeUnit || '').trim().toLowerCase();
  out.sizeUnit = (unit === 'mass' || unit === 'volume') ? unit : 'auto';
  const limitParsed = Number.parseInt(raw.limit, 10);
  out.limit = Number.isFinite(limitParsed) ? Math.max(1, Math.min(limitParsed, 40)) : REMOTE_SUGGESTION_LIMIT;
  return out;
}

function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw);
    return sanitizeFilters(parsed);
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters(state) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function applyFiltersToDom(filters) {
  const state = sanitizeFilters(filters);
  if (filterCategoryInput) filterCategoryInput.value = state.category || '';
  if (filterSubcategoryInput) filterSubcategoryInput.value = state.subcategory || '';
  if (filterBrandInput) filterBrandInput.value = state.brand || '';
  if (filterLactoseFreeInput) filterLactoseFreeInput.checked = !!state.lactoseFree;
  if (filterFatMinInput) filterFatMinInput.value = state.fatMin ?? '';
  if (filterFatMaxInput) filterFatMaxInput.value = state.fatMax ?? '';
  if (filterSizeMinInput) filterSizeMinInput.value = state.sizeMin ?? '';
  if (filterSizeMaxInput) filterSizeMaxInput.value = state.sizeMax ?? '';
  if (filterSizeUnitSelect) filterSizeUnitSelect.value = state.sizeUnit || 'auto';
}

function readNumberFromInput(input) {
  if (!input) return null;
  const raw = String(input.value || '').trim();
  if (!raw) return null;
  const parsed = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function readFiltersFromDom() {
  return sanitizeFilters({
    category: filterCategoryInput?.value,
    subcategory: filterSubcategoryInput?.value,
    brand: filterBrandInput?.value,
    lactoseFree: !!(filterLactoseFreeInput && filterLactoseFreeInput.checked),
    fatMin: readNumberFromInput(filterFatMinInput),
    fatMax: readNumberFromInput(filterFatMaxInput),
    sizeMin: readNumberFromInput(filterSizeMinInput),
    sizeMax: readNumberFromInput(filterSizeMaxInput),
    sizeUnit: filterSizeUnitSelect?.value || 'auto',
    limit: REMOTE_SUGGESTION_LIMIT
  });
}

function countActiveFilters(filters) {
  const state = sanitizeFilters(filters);
  let count = 0;
  if (state.category) count++;
  if (state.subcategory) count++;
  if (state.brand) count++;
  if (state.lactoseFree) count++;
  if (typeof state.fatMin === 'number') count++;
  if (typeof state.fatMax === 'number') count++;
  if (typeof state.sizeMin === 'number') count++;
  if (typeof state.sizeMax === 'number') count++;
  return count;
}

function updateFiltersSummaryLabel(state = searchFilters) {
  if (!filtersSummary) return;
  const count = countActiveFilters(state);
  filtersSummary.textContent = count ? `Avanserte filtre (${count})` : 'Avanserte filtre';
  if (count) filtersSummary.setAttribute('data-active-count', String(count));
  else filtersSummary.removeAttribute('data-active-count');
}

function hasActiveFilters(filters) {
  return countActiveFilters(filters) > 0;
}

function cloneFilters(filters) {
  return sanitizeFilters(filters);
}

function onFiltersChanged() {
  searchFilters = readFiltersFromDom();
  saveFilters(searchFilters);
  updateFiltersSummaryLabel(searchFilters);
  scheduleSuggestionRefresh();
}

let suggestionTimer = null;
function scheduleSuggestionRefresh(delay = 150) {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(updateSuggestions, delay);
}

function applyFiltersToUrl(url, filters, extras = {}) {
  if (!url || !filters) return;
  const state = sanitizeFilters(filters);
  if (state.category) url.searchParams.set('category', state.category);
  if (state.subcategory) url.searchParams.set('subcategory', state.subcategory);
  if (state.brand) url.searchParams.set('brand', state.brand);
  if (state.lactoseFree) url.searchParams.set('lactoseFree', 'true');
  if (typeof state.fatMin === 'number') url.searchParams.set('fatPctMin', String(state.fatMin));
  if (typeof state.fatMax === 'number') url.searchParams.set('fatPctMax', String(state.fatMax));
  if (typeof state.sizeMin === 'number') url.searchParams.set('unitMin', String(state.sizeMin));
  if (typeof state.sizeMax === 'number') url.searchParams.set('unitMax', String(state.sizeMax));
  if (state.sizeUnit && state.sizeUnit !== 'auto') url.searchParams.set('unitType', state.sizeUnit);
  const limit = typeof extras.limit === 'number' ? extras.limit : state.limit;
  if (typeof limit === 'number') url.searchParams.set('limit', String(limit));
}

function resetFilters() {
  searchFilters = { ...DEFAULT_FILTERS };
  applyFiltersToDom(searchFilters);
  saveFilters(searchFilters);
  updateFiltersSummaryLabel(searchFilters);
  scheduleSuggestionRefresh();
}

function loadPrefChainsEnabled() {
  try { return localStorage.getItem(LS_PREF_ENABLED) === '1'; } catch { return false; }
}
function savePrefChainsEnabled(v) {
  try { localStorage.setItem(LS_PREF_ENABLED, v ? '1' : '0'); } catch {}
}
function loadPrefChains() {
  try {
    const raw = localStorage.getItem(LS_PREF_CHAINS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePrefChains(arr) {
  try { localStorage.setItem(LS_PREF_CHAINS, JSON.stringify(arr || [])); } catch {}
}
function getActiveGroupsParam() {
  if (getCurrentScope() === 'online') return null;
  if (!loadPrefChainsEnabled()) return null;
  const sel = loadPrefChains();
  return (sel && sel.length) ? sel.join(',') : null;
}

// ---- Forslags-scoring ----
const MAX_SUGGESTIONS = 25;
function normTxt(s) {
  return String(s || '').normalize('NFKD').replace(/\p{Diacritic}+/gu, '').toLowerCase().trim();
}
function parseSizeMl(s) {
  const txt = normTxt(s).replace(/,/g, '.');
  const multi = txt.match(/(\d+)\s*[x×]\s*([\d.]+)\s*(ml|l|cl)/i);
  if (multi) {
    const n = Number(multi[1]); const per = Number(multi[2]); const unit = multi[3];
    const perMl = unit === 'ml' ? per : unit === 'cl' ? per * 10 : per * 1000;
    if (!Number.isNaN(n) && !Number.isNaN(perMl)) return n * perMl;
  }
  const m = txt.match(/([\d.]+)\s*(ml|l|cl)\b/);
  if (m) {
    const val = Number(m[1]); const unit = m[2];
    if (!Number.isNaN(val)) { if (unit === 'ml') return val; if (unit === 'cl') return val * 10; if (unit === 'l') return val * 1000; }
  }
  const m2 = txt.match(/([\d.]+)\s*(liter|ltr|l)\b/);
  if (m2 && !Number.isNaN(Number(m2[1]))) return Number(m2[1]) * 1000;
  return null;
}
function desiredSizeFromQuery(q) { return parseSizeMl(q); }
const PACK_HINTS = { bottle: ['flaske','bottle'], can: ['boks','can','boks(er)'] };
function hasAny(hay, words) { return words.some(w => hay.includes(w)); }
function scoreOptionForQuery(o, q) {
  const qn = normTxt(q);
  const name = normTxt(o.name || o.label || '');
  const brand = normTxt(o.brand || '');
  const meta = normTxt(o.size || o.meta || '');
  const allTxt = `${name} ${brand} ${meta}`;
  let score = 0;
  if (name.startsWith(qn)) score += 6;
  if (brand && brand.startsWith(qn)) score += 4;
  if (name.includes(qn)) score += 3;
  if (brand && brand.includes(qn)) score += 2;
  if (allTxt.includes(qn)) score += 1;
  if (/^\d{8,14}$/.test(q) && (o.ean === q || (o.meta && o.meta.includes(q)))) score += 5;
  const wantMl = desiredSizeFromQuery(q);
  if (wantMl) {
    const sMl = parseSizeMl(o.size || o.meta || o.label || '');
    if (sMl) {
      const diff = Math.abs(sMl - wantMl) / wantMl;
      if (diff <= 0.05) score += 8;
      else if (diff <= 0.15) score += 4;
      else if (diff <= 0.30) score += 1;
      else score -= 1;
    }
  }
  const qh = normTxt(q);
  if (hasAny(qh, PACK_HINTS.bottle) && hasAny(allTxt, PACK_HINTS.bottle)) score += 2;
  if (hasAny(qh, PACK_HINTS.can)    && hasAny(allTxt, PACK_HINTS.can))    score += 2;
  if (name.length <= 4) score -= 0.5;
  return score;
}
function rankOptions(q, options) {
  return (options || [])
    .map(o => ({ ...o, _score: scoreOptionForQuery(o, q) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ _score, ...rest }) => rest);
}

// ————— NOK-format —————
function formatNOK(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return n.toLocaleString('no-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ————— Normalisering av products.json —————
function normalizeProducts(data) {
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((p) => {
      const name = p.name ?? p.title ?? p.product_name ?? p.product ?? p.navn ?? '';
      const brand = p.brand ?? p.manufacturer ?? p.producer ?? p.merke ?? '';
      const size = p.size ?? p.quantity ?? p.packaging ?? p.pack_size ?? p.størrelse ?? '';
      const eanRaw = p.ean ?? p.gtin ?? p.barcode ?? p.ean13 ?? '';
      const ean = eanRaw ? String(eanRaw).replace(/\D/g, '') : '';
      let id = p.id ?? p.productId ?? p._id ?? '';
      if (!id) {
        if (ean) id = `ean:${ean}`;
        else {
          const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
          id = `n:${slug}|${size || ''}`;
        }
      }
      return { id, name, brand, size, ean };
    })
    .filter(p => p.name && typeof p.name === 'string');
}

// ————— Init: last lokalt datasett —————
(async function init() {
  try {
    const DATA_URL = new URL('./data/products.json', document.baseURI).href;
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${DATA_URL}`);
    const raw = await res.json();
    products = normalizeProducts(raw);
    console.info(`products.json lastet (${products.length} varer) fra:`, DATA_URL);
    if (products.length) console.log('Eksempel (første):', products[0]);
  } catch (e) {
    console.error('Kunne ikke laste products.json', e);
    products = [];
    const s = document.getElementById('status');
    if (s) s.textContent = 'Feil: products.json ikke lastet';
  }
  renderList();
  debouncedUpdateSingleStoreSummary();
})();

// --- Forslag fra Kassalapp via Netlify Function (minLength=3) ---
let suggestCtrl;
async function fetchKassalappSuggestions(q) {
  const sq = sanitizeQuery(q);
  if (!sq || sq.length < 3) return [];
  try {
    if (suggestCtrl) suggestCtrl.abort();
    suggestCtrl = new AbortController();

    const u = new URL('/.netlify/functions/kassalapp', location.origin);
    u.searchParams.set('q', sq);
    u.searchParams.set('scope', getCurrentScope());
    const g = getActiveGroupsParam();
    if (g) u.searchParams.set('group', g);

    const resp = await fetch(u.toString(), { signal: suggestCtrl.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { items = [] } = await resp.json();

    return items
      .filter(p => p && p.ean)
      .slice(0, MAX_SUGGESTIONS)
      .map(p => {
        const ean = cleanEAN(p.ean);
        return {
          id: `ean:${ean}`,
          type: 'product-remote',
          label: `${p.name} — ${p.brand || 'Uten brand'} (${p.size || ''})`,
          meta: `EAN: ${ean}${p.store ? ` · ${p.store}` : ''}`,
          ean, name: p.name || '', brand: p.brand || '', size: p.size || ''
        };
      });
  } catch {
    return [];
  }
}

// ————— Søk: input + debounce + tastatur —————
let activeIndex = -1;
searchInput?.addEventListener('input', () => scheduleSuggestionRefresh());
searchInput?.addEventListener('keydown', onSearchKeyDown);
suggestions?.addEventListener('click', (e) => {
  const li = e.target.closest('li[role="option"]');
  if (!li) return;
  addProductFromOption(li.dataset.id, li);
});

filterCategoryInput?.addEventListener('input', onFiltersChanged);
filterSubcategoryInput?.addEventListener('input', onFiltersChanged);
filterBrandInput?.addEventListener('input', onFiltersChanged);
filterLactoseFreeInput?.addEventListener('change', onFiltersChanged);
filterFatMinInput?.addEventListener('input', onFiltersChanged);
filterFatMaxInput?.addEventListener('input', onFiltersChanged);
filterSizeMinInput?.addEventListener('input', onFiltersChanged);
filterSizeMaxInput?.addEventListener('input', onFiltersChanged);
filterSizeUnitSelect?.addEventListener('change', onFiltersChanged);
filterResetBtn?.addEventListener('click', resetFilters);

// ————— Søkekomponent —————
async function updateSuggestions() {
  if (!searchInput) return;
  const q = (searchInput.value || '').trim();
  const local = computeLocalOptions(q);
  const remote = await fetchKassalappSuggestions(q);
  const merged = uniqueBy([...local, ...remote], o => o.id);
  const ranked = rankOptions(q, merged);
  drawSuggestions(ranked);
}
function computeLocalOptions(q) {
  if (!q) return [];
  const isDigits = /^\d+$/.test(q);
  const out = [];
  if (isDigits && q.length >= 8 && q.length <= 14) {
    const valid = validateEAN13(q);
    out.push({
      id: `ean:${q}`,
      label: valid ? `➕ Legg til via EAN ${q} (gyldig)` : `➕ Legg til via EAN ${q} (ukjent/ugyldig)`,
      meta: valid ? 'EAN-13 ok' : 'Kontrollsiffer mangler/feil',
      type: 'ean'
    });
  }
  const norm = q.toLowerCase();
  const results = products
    .map(p => {
      const name = p.name.toLowerCase();
      const brand = (p.brand || '').toLowerCase();
      let score = 0;
      if (name.startsWith(norm)) score += 3;
      if (brand && brand.startsWith(norm)) score += 2;
      if (name.includes(norm)) score += 1;
      if (brand && brand.includes(norm)) score += 0.5;
      if (isDigits && p.ean && p.ean.startsWith(q)) score += 2;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ p }) => ({
      id: p.id,
      type: 'product',
      label: `${p.name} — ${p.brand || 'Uten brand'} (${p.size || ''})`,
      meta: p.ean ? `EAN: ${p.ean}` : '',
      name: p.name, brand: p.brand, size: p.size, ean: p.ean
    }));
  return [...out, ...results];
}
function mapRemoteItemToOption(p) {
  const ean = cleanEAN(p?.ean);
  if (!ean) return null;
  const parts = [p.name, p.brand, p.size].filter((segment) => segment && String(segment).trim());
  const label = parts.length ? parts.join(' - ') : `EAN ${ean}`;
  const metaBits = [`EAN: ${ean}`];
  if (p.category) metaBits.push(p.category);
  if (typeof p.pricePerKg === 'number') metaBits.push(`${formatNOK(p.pricePerKg)}/kg`);
  if (typeof p.pricePerLiter === 'number') metaBits.push(`${formatNOK(p.pricePerLiter)}/L`);
  const fatPct = p.attributes && typeof p.attributes.fatPct === 'number' ? p.attributes.fatPct : null;
  if (typeof fatPct === 'number') metaBits.push(`${fatPct}% fett`);
  if (p.store) metaBits.push(p.store);
  return {
    id: `ean:${ean}`,
    type: 'product-remote',
    label,
    meta: metaBits.filter(Boolean).join(' � '),
    ean,
    name: p.name || '',
    brand: p.brand || '',
    size: p.size || '',
    category: p.category || '',
    attributes: p.attributes || {},
    pricePerKg: typeof p.pricePerKg === 'number' ? p.pricePerKg : null,
    pricePerLiter: typeof p.pricePerLiter === 'number' ? p.pricePerLiter : null
  };
}function drawSuggestions(opts) {
  if (!suggestions || !searchInput) return;
  suggestions.innerHTML = '';
  if (!opts.length) {
    suggestions.dataset.open = 'false';
    searchInput.setAttribute('aria-expanded', 'false');
    return;
  }
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const li = document.createElement('li');
    li.role = 'option';
    li.id = `opt-${i}`;
    li.dataset.id = o.id;
    li.dataset.type = o.type || 'product';
    if (o.ean)   li.dataset.ean = o.ean;
    if (o.name)  li.dataset.name = o.name;
    if (o.brand) li.dataset.brand = o.brand;
    if (o.size)  li.dataset.size = o.size;
    li.tabIndex = -1;
    li.innerHTML = `<div>${o.label}</div><small>${o.meta || ''}</small>`;
    suggestions.appendChild(li);
  }
  activeIndex = -1;
  suggestions.dataset.open = 'true';
  searchInput.setAttribute('aria-expanded', 'true');
}
function onSearchKeyDown(e) {
  if (!suggestions || !searchInput) return;
  const open = suggestions.dataset.open === 'true';
  const items = Array.from(suggestions.querySelectorAll('li[role="option"]'));
  if (e.key === 'ArrowDown' && open) {
    e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); setActive();
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); setActive();
  } else if (e.key === 'Enter') {
    if (open && activeIndex >= 0) {
      e.preventDefault(); addProductFromOption(items[activeIndex].dataset.id, items[activeIndex]);
    } else if (searchInput.value.trim()) {
      const q = searchInput.value.trim();
      if (/^\d{8,14}$/.test(q)) addByEAN(q);
      else addCustom(q);
    }
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
}
function setActive() {
  const items = Array.from(suggestions.querySelectorAll('li[role="option"]'));
  items.forEach((li, i) => {
    const sel = i === activeIndex;
    li.setAttribute('aria-selected', sel ? 'true' : 'false');
    if (sel) {
      searchInput.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  });
}
function closeSuggestions() {
  if (!suggestions || !searchInput) return;
  suggestions.dataset.open = 'false';
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}

// ————— Handleliste (storage) —————
function loadList() {
  try { const raw = localStorage.getItem('sso:list'); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveList() { try { localStorage.setItem('sso:list', JSON.stringify(list)); } catch {} }

// ————— Prisoppslag via Netlify Function —————
async function fetchKassalappPriceByEAN(ean) {
  const code = cleanEAN(ean);
  if (!(code.length >= 8 && code.length <= 14)) return null;
  try {
    const u = new URL('/.netlify/functions/kassalapp', location.origin);
    u.searchParams.set('ean', code);
    u.searchParams.set('scope', getCurrentScope());
    const g = getActiveGroupsParam();
    if (g) u.searchParams.set('group', g);
    const res = await fetch(u.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch { return null; }
}
async function fetchKassalappPriceByEANWithRetry(ean, tries = 3, delay = 600) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchKassalappPriceByEAN(ean);
    if (r) return r;
    await new Promise(r => setTimeout(r, delay * (i + 1)));
  }
  return null;
}

// ————— Foretrukne butikker —————
function setupChainsDropdown() {
  const root = document.getElementById('chainsDropdownRoot');
  const btn  = document.getElementById('chainsBtn');
  const menu = document.getElementById('chainsDropdown');
  const list = document.getElementById('chainsList');
  const chk  = document.getElementById('prefChainsEnabled');
  if (!root || !btn || !menu || !list || !chk) return;

  // Korrekt aktiv-klasse ved init
  btn.classList.toggle('active-filter', loadPrefChainsEnabled());

  // Bygg liste (alfabetisk)
  const selected = new Set(loadPrefChains());
  list.innerHTML = '';
  const sorted = [...CHAIN_DEFS].sort((a, b) => a.label.localeCompare(b.label, 'no'));
  for (const c of sorted) {
    const li = document.createElement('li');
    li.role = 'option';
    li.tabIndex = 0;
    li.dataset.code = c.code;
    const isSel = selected.has(c.code);
    li.className = `chain-item ${isSel ? 'is-selected' : 'is-unselected'}`;
    li.innerHTML = `<span class="dot"></span><span class="label">${c.label}</span>`;
    li.addEventListener('click', () => toggleChain(li.dataset.code));
    li.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleChain(li.dataset.code); }
    });
    list.appendChild(li);
  }

  function toggleChain(code) {
    const set = new Set(loadPrefChains());
    if (set.has(code)) set.delete(code); else set.add(code);
    savePrefChains([...set]);
    [...list.children].forEach(li => {
      const on = set.has(li.dataset.code);
      li.classList.toggle('is-selected', on);
      li.classList.toggle('is-unselected', !on);
    });
    if (loadPrefChainsEnabled()) {
      updateSuggestions();
      renderList();
      debouncedUpdateSingleStoreSummary();
    }
  }

  // Slider
  chk.checked = loadPrefChainsEnabled();
  chk.addEventListener('change', () => {
    savePrefChainsEnabled(chk.checked);
    btn.classList.toggle('active-filter', chk.checked);
    updateSuggestions();
    renderList();
    debouncedUpdateSingleStoreSummary();
  });

  // Åpne/lukke + auto-flip
  btn.addEventListener('click', () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      menu.classList.remove('is-right-anchored');
      menu.style.left = ''; menu.style.right = '';
      const rect = menu.getBoundingClientRect();
      const overflowRight = rect.right > window.innerWidth;
      if (overflowRight) { menu.classList.add('is-right-anchored'); menu.style.left = 'auto'; menu.style.right = '0'; }
      else { menu.classList.remove('is-right-anchored'); menu.style.left = '0'; menu.style.right = 'auto'; }
    }
  });

  // ✅ NYTT: Lukk ved klikk utenfor
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', (ev) => {
    // Lukker hvis klikket ikke er inne i root (knapp eller meny)
    // Node.contains er trygg måte å sjekke dette på. :contentReference[oaicite:2]{index=2}
    if (!root.contains(ev.target)) closeMenu();
  });

  // ✅ NYTT: Lukk med Escape (tastatur-tilgjengelighet)
  // APG anbefaler at slike menyer kan lukkes med Esc. :contentReference[oaicite:3]{index=3}
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });

  // Re-posisjoner ved resize/zoom
  window.addEventListener('resize', () => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.click();
  });
}

// ————— RENDER LISTE (med prisfelt) —————
function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const item of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${item.name}</strong>
        <div class="hint">${item.brand || ''} ${item.size || ''} ${item.ean ? ' — EAN: ' + item.ean : ''}</div>
      </div>
      <span class="price" aria-label="Laveste pris">…</span>
      <input class="qty" name="qty" type="number" min="1" max="999" step="1" value="${item.qty || 1}" aria-label="Antall for ${item.name}">
      <button class="btn btn-outline" data-id="${item.id}">Fjern</button>
    `;
    const qty = li.querySelector('.qty');
    qty.addEventListener('change', () => {
      item.qty = Math.max(1, Number(qty.value || 1));
      saveList();
      debouncedUpdateSingleStoreSummary();
    });
    li.querySelector('button').addEventListener('click', () => {
      list = list.filter(x => x.id !== item.id);
      saveList();
      renderList();
      debouncedUpdateSingleStoreSummary();
    });
    listEl.appendChild(li);

    if (item.ean) {
      fetchKassalappPriceByEANWithRetry(item.ean).then(result => {
        applyBestPriceToListItem(li, result);
        debouncedUpdateSingleStoreSummary();
      });
    } else {
      applyBestPriceToListItem(li, null);
    }
  }
  debouncedUpdateSingleStoreSummary();
}

// ————— Fyll inn pris i ett liste-element —————
function applyBestPriceToListItem(li, result) {
  const out = li.querySelector('.price');
  if (!out) return;

  if (!result || !result.bestPrice || typeof result.bestPrice.price !== 'number') {
    out.textContent = '—';
    out.title = 'Ingen pris funnet';
    const e = extractEANFromLI(li);
    const sc = getCurrentScope();
    if (e && result && Array.isArray(result.items)) {
      pricesByKey.set(cacheKey(e, sc), result.items.filter(x => typeof x.price === 'number' && x.store));
    }
    return;
  }

  const { price, store, updatedAt, name, brand, size, ean } = result.bestPrice;
  const priceFormatted = Number(price).toLocaleString('no-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  out.textContent = `${priceFormatted} kr${store ? ' @ ' + store : ''}`;
  out.title = updatedAt ? `Oppdatert: ${updatedAt}` : '';

  const titleEl = li.querySelector('div > strong');
  const hintEl  = li.querySelector('div .hint');
  if (titleEl && name && (/^Strekkode\s/.test(titleEl.textContent) || !titleEl.textContent.trim())) {
    titleEl.textContent = name;
  }
  if (hintEl) {
    const parts = [];
    if (brand) parts.push(brand);
    if (size)  parts.push(size);
    if (ean)   parts.push(`— EAN: ${ean}`);
    hintEl.textContent = parts.join(' ');
  }

  const id = li.querySelector('button.btn.btn-outline')?.dataset.id;
  const hit = list.find(x => x.id === id);
  if (hit) {
    if (name) hit.name = name;
    if (brand) hit.brand = brand;
    if (size) hit.size = size;
    if (ean) hit.ean = ean;
    saveList();
  }

  const sc = getCurrentScope();
  const keyEAN = ean || extractEANFromLI(li);
  if (keyEAN && Array.isArray(result.items)) {
    const offers = result.items.filter(o => typeof o.price === 'number' && o.store);
    pricesByKey.set(cacheKey(keyEAN, sc), offers);
  }
}
function extractEANFromLI(li) {
  const hint = li.querySelector('.hint')?.textContent || '';
  const m = hint.match(/EAN:\s*(\d{8,14})/);
  return m ? m[1] : null;
}

// ————— Legg til i liste —————
function addProductFromOption(optId, liEl) {
  const type = liEl?.dataset.type || '';
  if (optId.startsWith('ean:')) {
    const raw = optId.slice(4);
    const code = cleanEAN(raw);
    if (type === 'product-remote' && liEl?.dataset.ean) {
      const metaEAN = cleanEAN(liEl.dataset.ean);
      const item = {
        id: `ean:${code}`,
        name: liEl.dataset.name || `Strekkode ${code}`,
        brand: liEl.dataset.brand || '',
        size: liEl.dataset.size || '',
        ean: metaEAN || code,
        qty: 1
      };
      addToList(item);
      if (searchInput) searchInput.value = '';
      closeSuggestions();
      return;
    }
    addByEAN(code);
    return;
  }
  const p = products.find(x => x.id === optId);
  if (!p) return;
  addToList({ id: `p:${p.id}`, name: p.name, brand: p.brand, size: p.size, ean: p.ean, qty: 1 });
  if (searchInput) searchInput.value = '';
  closeSuggestions();
}
function addByEAN(code) {
  const clean = cleanEAN(code);
  const valid = validateEAN13(clean);
  const found = products.find(p => p.ean === clean);
  if (found) {
    addToList({ id: `p:${found.id}`, name: found.name, brand: found.brand, size: found.size, ean: found.ean, qty: 1 });
  } else {
    const name = valid ? `Strekkode ${clean}` : `Ukjent strekkode ${clean}`;
    addToList({ id: `ean:${clean}`, name, brand: '', size: '', ean: valid ? clean : undefined, qty: 1 });
  }
  if (searchInput) searchInput.value = '';
  closeSuggestions();
}
function addCustom(text) {
  const name = text.trim().slice(0, 120);
  if (!name) return;
  addToList({ id: `c:${Date.now()}`, name, brand: '', size: '', qty: 1 });
  if (searchInput) searchInput.value = '';
  closeSuggestions();
}
function addToList(item) {
  const hit = list.find(x => x.id === item.id);
  if (hit) { hit.qty = (hit.qty || 1) + (item.qty || 1); }
  else { list.unshift(item); }
  saveList(); renderList();
  debouncedUpdateSingleStoreSummary();
}

// ————— EAN-13 validering —————
function validateEAN13(code) {
  const s = String(code).replace(/\D/g, '');
  if (s.length !== 13) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}

// ————— Tøm handleliste —————
clearListBtn?.addEventListener('click', () => {
  if (confirm('Tøm handleliste?')) {
    list = [];
    saveList();
    renderList();
    debouncedUpdateSingleStoreSummary();
  }
});

/* ============================================================
   ÉN-BUTIKK: beregn topp 3 butikker basert på cache
   ============================================================ */
const singleStoreListEl = document.getElementById('singleStoreList');
const singleStoreMissingEl = document.getElementById('singleStoreMissing');

function aggregateBestPerStoreFromCache() {
  if (!Array.isArray(list) || list.length === 0) {
    return { storeTotals: new Map(), missing: 0, considered: 0, expectedPerStore: 0, minSum: 0, maxSum: 0 };
  }
  const scope = getCurrentScope();
  const totals = new Map(); let missing = 0; let considered = 0;
  const expected = list.filter(it => !!it?.ean).length;

  for (const item of list) {
    if (!item?.ean) { missing++; continue; }
    const offers = pricesByKey.get(cacheKey(item.ean, scope));
    if (!offers || !offers.length) { missing++; continue; }

    const qty = Math.max(1, Number(item.qty || 1));
    const perStorePrice = new Map();
    for (const o of offers) {
      if (typeof o.price === 'number' && o.store) {
        const prev = perStorePrice.get(o.store);
        if (prev == null || o.price < prev) perStorePrice.set(o.store, o.price);
      }
    }
    if (perStorePrice.size === 0) { missing++; continue; }

    for (const [store, unitPrice] of perStorePrice.entries()) {
      const info = totals.get(store) || { sum: 0, items: 0 };
      info.sum += unitPrice * qty;
      info.items += 1;
      totals.set(store, info);
    }
    considered++;
  }

  let minSum = Infinity, maxSum = -Infinity;
  for (const [, info] of totals) {
    if (info.sum < minSum) minSum = info.sum;
    if (info.sum > maxSum) maxSum = info.sum;
  }
  if (!isFinite(minSum)) minSum = 0;
  if (!isFinite(maxSum)) maxSum = 0;

  return { storeTotals: totals, missing, considered, expectedPerStore: expected, minSum, maxSum };
}

function renderSingleStoreSummary() {
  if (!singleStoreListEl) return;
  const { storeTotals, missing, considered, expectedPerStore, minSum, maxSum } = aggregateBestPerStoreFromCache();

  const entries = [...storeTotals.entries()].map(([store, info]) => {
    const coverage = expectedPerStore ? (info.items / expectedPerStore) : 0;
    const priceNorm = (maxSum > minSum) ? (info.sum - minSum) / (maxSum - minSum) : 0;
    const score = priceNorm - (coverage * COVERAGE_WEIGHT);
    return { store, sum: info.sum, items: info.items, coverage, score };
  });

  const filtered = entries.filter(e => e.coverage >= MIN_COVERAGE);
  const ranked = filtered
    .sort((a, b) => (a.score - b.score) || (b.coverage - a.coverage) || (a.sum - b.sum))
    .slice(0, 3);

  singleStoreListEl.innerHTML = '';
  if (ranked.length === 0) {
    const fallback = entries.sort((a, b) => (a.sum - b.sum)).slice(0, 3);
    for (const e of fallback) {
      const li = document.createElement('li');
      const pct = Math.round(e.coverage * 100);
      li.innerHTML = `
        <div>
          <strong>${e.store}</strong>
          <small style="color:var(--color-danger, #b91c1c)">lav dekning ${pct}% · ${e.items} av ${expectedPerStore} varer</small>
        </div>
        <div class="sum">${formatNOK(e.sum)} kr</div>
      `;
      singleStoreListEl.appendChild(li);
    }
  } else {
    for (const e of ranked) {
      const li = document.createElement('li');
      const pct = Math.round(e.coverage * 100);
      li.innerHTML = `
        <div>
          <strong>${e.store}</strong>
          <small>prisdekning ${pct}% · ${e.items} av ${expectedPerStore} varer</small>
        </div>
        <div class="sum">${formatNOK(e.sum)} kr</div>
      `;
      singleStoreListEl.appendChild(li);
    }
  }

  if (singleStoreMissingEl) {
    if (missing > 0 || considered > 0) {
      singleStoreMissingEl.textContent = `Manglende priser: ${missing} · Varer vurdert: ${considered}`;
    } else {
      singleStoreMissingEl.textContent = '';
    }
  }
}

let singleStoreTimer;
function debouncedUpdateSingleStoreSummary() {
  clearTimeout(singleStoreTimer);
  singleStoreTimer = setTimeout(renderSingleStoreSummary, 120);
}

// Kjør oppsummering + aktiver dropdown etter at siden er lastet
window.addEventListener('load', () => {
  debouncedUpdateSingleStoreSummary();
  setupChainsDropdown();
});

// === Multistore adapter hooks (prioriterer sso:list, fleksibel pris-cache) ===
(function () {
  function uniq(arr) { return Array.from(new Set(arr)); }
  const EAN_RE = /^\d{8,14}$/;
  const DEV_LOG = true;

  function tryParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

  // --- EAN-ekstraksjon ---
  function eansFromArray(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      if (typeof it === "string" && EAN_RE.test(it)) out.push(it);
      else if (typeof it === "number" && EAN_RE.test(String(it))) out.push(String(it));
      else if (it && typeof it === "object") {
        const cand =
          it.ean || it.barcode || it.code || it.id ||
          (it.product && (it.product.ean || it.product.barcode || it.product.code));
        if (typeof cand === "string" && EAN_RE.test(cand)) out.push(cand);
        else if (typeof cand === "number" && EAN_RE.test(String(cand))) out.push(String(cand));
      }
    }
    return out;
  }
  function eansFromObject(o) {
    if (!o || typeof o !== "object") return [];
    const keys = ["items","cart","list","products","entries","lines"];
    let out = [];
    for (const k of keys) if (Array.isArray(o[k])) out = out.concat(eansFromArray(o[k]));
    return out.concat(eansFromArray([o]));
  }

  function readCartEansRobust() {
    let eans = [];
    let source = null;

    // Primærkilde i din app: localStorage["sso:list"]
    {
      const val = localStorage.getItem("sso:list");
      const parsed = tryParseJSON(val);
      if (Array.isArray(parsed)) {
        eans = eansFromArray(parsed);
        if (eans.length) source = 'localStorage["sso:list"] (array)';
      }
    }

    // Andre LS-nøkler om ikke funnet
    if (!eans.length) {
      const pri = ["sso:cart","cart","handleliste","shoppingList"];
      for (const k of pri) {
        const val = localStorage.getItem(k);
        if (!val) continue;
        const parsed = tryParseJSON(val);
        if (Array.isArray(parsed)) { eans = eansFromArray(parsed); source = `localStorage["${k}"] (array)`; }
        else if (parsed && typeof parsed === "object") { eans = eansFromObject(parsed); source = `localStorage["${k}"] (object)`; }
        if (eans.length) break;
      }
    }

    // Globale fallbacks
    if (!eans.length) {
      const tries = [
        ["window.cart", window.cart],
        ["window.CART", window.CART],
        ["window.SHOPPING_LIST", window.SHOPPING_LIST],
        ["window.SHOPPING?.cart", window.SHOPPING && window.SHOPPING.cart]
      ];
      for (const [label, obj] of tries) {
        eans = eansFromObject(obj).concat(eansFromArray(obj));
        if (eans.length) { source = label; break; }
      }
    }

    // Nød-fallback – avled fra pricesByKey
    if (!eans.length && window.pricesByKey && typeof window.pricesByKey === "object") {
      for (const key of Object.keys(window.pricesByKey)) {
        const m = key.match(/^(\d{8,14})(?:\|.*)?$/);
        if (m) eans.push(m[1]);
      }
      if (eans.length) source = "pricesByKey keys";
    }

    const unique = uniq(eans.filter(Boolean));
    if (DEV_LOG) console.log(`[SSO] getCartEans(): ${unique.length} EAN fra ${source || "ingen"}`, unique.slice(0,50));
    return unique;
  }

  // --- Pris-oppslag fra cache (støtter flere nøkkelvarianter) ---
  function getOffersFromCaches(ean, scope) {
    const pbk =
      (typeof window.pricesByKey === "object" && window.pricesByKey) ||
      tryParseJSON(localStorage.getItem("sso:pricesByKey")) ||
      {};

    const keysToTry = [
      ean,
      `ean:${ean}`,
      `${ean}|${scope}`,
      `${ean}|online`,
      `${ean}|physical`,
      `${ean}|both`,
      `${ean}|all`,
      `${ean}|*`
    ];

    if (pbk.eanMap && typeof pbk.eanMap === "object") {
      if (Array.isArray(pbk.eanMap[ean])) return pbk.eanMap[ean];
      if (Array.isArray(pbk.eanMap[`ean:${ean}`])) return pbk.eanMap[`ean:${ean}`];
    }

    for (let i = 0; i < keysToTry.length; i++) {
      const v = pbk[keysToTry[i]];
      if (Array.isArray(v)) return v;
    }

    if (typeof window.getOffersForEan === "function") {
      try {
        const v = window.getOffersForEan(ean, scope);
        if (Array.isArray(v)) return v;
      } catch {}
    }
    return [];
  }

  function readScopeFromUI() {
    // Typisk radioknapper: <input type="radio" name="scope" value="online|physical|both|all" checked>
    const el = document.querySelector('input[name="scope"]:checked');
    return el ? String(el.value || "").toLowerCase() : null;
  }

  function normalizeScope(s) {
    const v = String(s || "").toLowerCase();
    if (v === "online" || v === "physical") return v;
    if (v === "both" || v === "all") return "all";
    return null;
  }

  window.SSO_MULTISTORE_HOOKS = {
    // "online" | "physical" | "all"
    getScope() {
      // 1) eksplisitt global
      let s = normalizeScope(window.scope);
      if (s) return s;
      // 2) app-state om den finnes
      s = normalizeScope(window.APP_STATE && window.APP_STATE.scope);
      if (s) return s;
      // 3) localStorage
      s = normalizeScope(localStorage.getItem("sso:scope"));
      if (s) return s;
      // 4) UI
      s = normalizeScope(readScopeFromUI());
      if (s) return s;
      // 5) fallback
      return "all";
    },

    // Array av EAN-strenger
    getCartEans() {
      return readCartEansRobust();
    },

    // Array av { store_id, store_name?, group, isOnline, price } for gitt EAN
    getPricesForEan(ean) {
      const scope = this.getScope();
      const offers = getOffersFromCaches(ean, scope);
      if (DEV_LOG && (!offers || !offers.length)) {
        console.warn(`[SSO] getPricesForEan(${ean}): ingen treff i cache (prøvde flere nøkler)`);
      }
      return offers || [];
    },

    // Foretrukne kjede-slugs
    getPreferredGroups() {
      const parsed = tryParseJSON(localStorage.getItem("sso:preferred:groups") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    },

    // Om foretrukne-filter er aktivt
    preferredOnlyActive() {
      return localStorage.getItem("sso:preferred:enabled") === "1";
    },

    // Gjenbruk eksisterende sjekk
    isOnlineStore(storeIdOrGroup) {
      if (typeof window.isOnlineStore === "function") return !!window.isOnlineStore(storeIdOrGroup);
      return (oda|kolonial|nettbutikk|online)/i.test(String(storeIdOrGroup || ""));
    },

    // Konstanter
    getConstants() {
      return {
        MIN_COVERAGE: (typeof window.MIN_COVERAGE === "number") ? window.MIN_COVERAGE : 0.6,
        COVERAGE_WEIGHT: (typeof window.COVERAGE_WEIGHT === "number") ? window.COVERAGE_WEIGHT : 50
      };
    }
  };
})();

