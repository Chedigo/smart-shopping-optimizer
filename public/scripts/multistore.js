/* Multistore (forenklet) â€“ radius for fysiske når tilgjengelig, ellers trygg fallback via kjeder fra tilbud */
(() => {
  const SEL = { panel: "#multistore-panel" };
  const DEBUG = false;

  const q = (sel, root = document) => root.querySelector(sel);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;
  const strOrNull = (v) => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
  };
  const pickNumber = (...vals) => {
    for (let i = 0; i < vals.length; i++) {
      const candidate = numOrNull(vals[i]);
      if (candidate !== null) return candidate;
    }
    return null;
  };
  function canonicalStoreId(store) {
    if (!store) return null;
    if (store.id && String(store.id).trim()) return String(store.id);
    if (store.storeId && String(store.storeId).trim()) return String(store.storeId);
    if (store.slug && String(store.slug).trim()) return String(store.slug);
    const group = store.group || store.chain || store.storeGroup || 'store';
    const name = store.name || store.displayName || 'noname';
    return `${group}:${name}`;
  }

  function normalizeStoreForMap(store) {
    if (!store) return null;
    const id = canonicalStoreId(store);
    if (!id) return null;
    const lat = Number.parseFloat(store.lat ?? store.latitude ?? store.position?.lat ?? store.location?.lat);
    const lng = Number.parseFloat(store.lng ?? store.longitude ?? store.position?.lng ?? store.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const base = {
      id,
      name: store.name || store.displayName || '',
      group: store.group || store.chain || store.storeGroup || '',
      lat,
      lng,
      isPhysical: !!(store.isPhysical ?? store.physical ?? store.storeType === 'physical'),
      isOnline: !!(store.isOnline ?? store.online ?? store.storeType === 'online')
    };
    return base;
  }


    async function updateMapMarkers({ candidates, displayRows, includePhysical, scopeIn, groupCSV, preferredOn, preferredGroups, rangeEl }) {
    const rankMap = new Map();
    const rowMeta = new Map();
    (displayRows || []).forEach((row, idx) => {
      if (row && row.id) {
        rankMap.set(row.id, idx);
        rowMeta.set(row.id, row);
      }
    });

    const mapRecords = [];
    const seen = new Set();
    (candidates || []).forEach((cand) => {
      const id = canonicalStoreId(cand);
      if (!id || seen.has(id)) return;
      let normalized = normalizeStoreForMap(cand);
      if (!normalized) {
        const rowInfo = rowMeta.get(id);
        if (rowInfo && Number.isFinite(rowInfo.lat) && Number.isFinite(rowInfo.lng)) {
          normalized = normalizeStoreForMap({ ...cand, lat: rowInfo.lat, lng: rowInfo.lng });
        }
      }
      if (!normalized) return;
      seen.add(id);
      const rankIdx = rankMap.get(id);
      normalized.priceRank = (typeof rankIdx === 'number' && rankIdx < 3) ? (rankIdx + 1) : null;
      mapRecords.push(normalized);
    });

    if (mapRecords.length) {
      mapRecords.sort((a, b) => {
        const rankA = rankMap.has(a.id) ? rankMap.get(a.id) : Number.POSITIVE_INFINITY;
        const rankB = rankMap.has(b.id) ? rankMap.get(b.id) : Number.POSITIVE_INFINITY;
        return rankA - rankB;
      });
      window.__SSO_MAP_PENDING_STORES = mapRecords;
      try { window.SSO_MAP?.feed(mapRecords); } catch (err) { console.warn('[SSO][multistore->map] feed() feilet (ikke kritisk):', err); }
      return;
    }

    if (!includePhysical || scopeIn === 'online') {
      window.__SSO_MAP_PENDING_STORES = [];
      return;
    }

    const center = await getCenterIfPermitted();
    if (!center) {
      window.__SSO_MAP_PENDING_STORES = [];
      return;
    }

    try {
      const radiusKm = clamp(parseFloat(rangeEl?.value || '10'), 5, 50);
      const rawStores = await (window.fetchPhysicalStoresNear?.({ lat: center.lat, lng: center.lng, km: radiusKm, size: 100 }) ?? Promise.resolve([]));
      let list = (rawStores || []).map((s) => normalizeStoreForMap({
        id: s.id,
        name: s.name,
        group: s.group,
        lat: Number.parseFloat(s.position?.lat ?? s.latitude ?? s.location?.lat),
        lng: Number.parseFloat(s.position?.lng ?? s.longitude ?? s.location?.lng),
        position: s.position,
        location: s.location,
        isPhysical: true,
        isOnline: false
      })).filter(Boolean);
      if (preferredOn && Array.isArray(preferredGroups) && preferredGroups.length > 0) {
        const chosen = new Set(preferredGroups);
        list = list.filter((item) => item.group && chosen.has(item.group));
      }
      list = list.map((item) => ({ ...item, priceRank: null }));
      window.__SSO_MAP_PENDING_STORES = list;
      try { window.SSO_MAP?.feed(list); } catch (err) { console.warn('[SSO][multistore->map] feed() feilet (ikke kritisk):', err); }
    } catch (err) {
      console.warn('[SSO][multistore] physical-stores fetch failed (ikke kritisk):', err);
      window.__SSO_MAP_PENDING_STORES = [];
    }

    async function getCenterIfPermitted() {
      if (!('geolocation' in navigator) || !navigator.permissions?.query) return null;
      try {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        if (st.state !== 'granted') return null;
        return await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, maximumAge: 300000, timeout: 3000 }
          );
        });
      } catch {
        return null;
      }
    }
  }
function formatNOK(n) {
    if (!isFinite(n)) return "â€“";
    return new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 }).format(n);
  }

  function getHooks() {
    const h = window.SSO_MULTISTORE_HOOKS || {};
    const required = ["getScope","getCartEans","getPricesForEan","getPreferredGroups","preferredOnlyActive","getConstants","isOnlineStore"];
    const missing = required.filter((k) => typeof h[k] !== "function");
    if (missing.length) throw new Error("Mangler adapter-hooks: " + missing.join(", "));
    return h;
  }

  function normalizeScope(s) {
    const v = String(s || "").toLowerCase();
    if (v === "online" || v === "physical") return v;
    if (v === "both" || v === "all" || v === "") return "all";
    return "all";
  }

  async function requestPositionIfNeeded(includePhysical, scope) {
    if (!includePhysical) return null;
    if (scope === "online") return null;
    const consent = confirm("For å finne nærmeste fysiske butikker innen radius trenger vi posisjonen din. Vil du gi tilgang nå?");
    if (!consent) return null;
    const pos = await new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (r) => resolve({ lat: r.coords.latitude, lng: r.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
    return pos;
  }

  async function fetchNearbyStores(origin, radiusKm, groupCSV) {
    const url = new URL("/.netlify/functions/kassalapp-stores", location.origin);
    url.searchParams.set("lat", origin.lat);
    url.searchParams.set("lng", origin.lng);
    url.searchParams.set("radius_km", String(radiusKm));
    url.searchParams.set("limit", "60");
    if (groupCSV) url.searchParams.set("group", groupCSV);
    const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j || j.ok === false) throw new Error("Kunne ikke hente fysiske butikker");
    return { stores: j.stores || [], debug: j.debug || [] };
  }

  function isOnlineByNameGroup(store, group) {
    const hay = String(store || "") + " " + String(group || "");
    return /(oda|kolonial|nettbutikk|online)/i.test(hay);
  }

  function normalizeOffersFromItems(json) {
    const items = (json && Array.isArray(json.items)) ? json.items : [];
    if (!items.length) return [];
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const price = (typeof it.price === "number") ? it.price : NaN;
      if (!isFinite(price)) continue;
      const storeName = (it.store !== undefined && it.store !== null) ? String(it.store) : null;
      const group = (it.group !== undefined && it.group !== null) ? String(it.group) : "";
      const store_id = (group !== "") ? group : (storeName !== null ? storeName : null);
      const isOnline = isOnlineByNameGroup(storeName, group);
      const pricePerKg = pickNumber(it.pricePerKg, it.unitPricing?.pricePerKg);
      const pricePerLiter = pickNumber(it.pricePerLiter, it.unitPricing?.pricePerLiter);
      const unitPricing = normalizeUnitPricingPayload(it.unitPricing);
      const packageInfo = normalizePackageInfoPayload(it.packageInfo);
      const entry = {
        store_id,
        store_name: (storeName !== null ? storeName : (group !== "" ? group : null)),
        group,
        isOnline,
        price,
        pricePerKg,
        pricePerLiter
      };
      if (unitPricing) entry.unitPricing = unitPricing;
      if (packageInfo) entry.packageInfo = packageInfo;
      out.push(entry);
    }
    return out;
  }

  function normalizeUnitPricingPayload(src) {
    if (!src || typeof src !== "object") return null;
    const normalized = {
      value: numOrNull(src.value),
      quantity: numOrNull(src.quantity),
      unit: strOrNull(src.unit),
      unitRaw: strOrNull(src.unitRaw),
      display: strOrNull(src.display),
      pricePerUnit: numOrNull(src.pricePerUnit),
      pricePerKg: numOrNull(src.pricePerKg),
      pricePerLiter: numOrNull(src.pricePerLiter),
      source: strOrNull(src.source)
    };
    return Object.values(normalized).some((v) => v !== null) ? normalized : null;
  }

  function normalizePackageInfoPayload(src) {
    if (!src || typeof src !== "object") return null;
    const normalized = {
      raw: strOrNull(src.raw),
      quantity: numOrNull(src.quantity),
      unit: strOrNull(src.unit),
      unitRaw: strOrNull(src.unitRaw),
      kilograms: numOrNull(src.kilograms),
      liters: numOrNull(src.liters)
    };
    return Object.values(normalized).some((v) => v !== null) ? normalized : null;
  }

  async function fetchOffersFromFunction(ean, scope, groupCSV) {
    const url = new URL("/.netlify/functions/kassalapp", location.origin);
    url.searchParams.set("ean", ean);
    if (scope) url.searchParams.set("scope", scope);  // all|physical|online
    if (groupCSV) url.searchParams.set("group", groupCSV); // UPPERCASE CSV
    let resp, json;
    try {
      resp = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
      json = await resp.json();
    } catch {
      return [];
    }
    if (!resp.ok) return [];
    return normalizeOffersFromItems(json);
  }

  async function hydrateOffersForEans(eans, scope, groupCSV, getFromCacheBound) {
    const out = new Map();
    for (const ean of eans) {
      const cached = getFromCacheBound(ean);
      if (Array.isArray(cached) && cached.length > 0) out.set(ean, cached);
    }
    const missing = eans.filter(e => !out.has(e));
    for (const ean of missing) {
      const offers = await fetchOffersFromFunction(ean, scope, groupCSV);
      if (Array.isArray(offers) && offers.length > 0) out.set(ean, offers);
    }
    return out;
  }

  function summarizeStoreTotalForEans(storeKey, eans, getOffersFn) {
    let found = 0, sum = 0;
    const details = [];
    eans.forEach((ean) => {
      const offers = getOffersFn(ean) || [];
      const candidates = offers.filter((o) => {
        if (storeKey.isPhysical) {
          return (o.group && storeKey.group && o.group === storeKey.group);
        } else {
          if (storeKey.store_id && o.store_id) return o.store_id === storeKey.store_id;
          return (o.isOnline === true) && (o.group && storeKey.group && o.group === storeKey.group);
        }
        // === KOBLING TIL KART (trygg og ikke-breaking) ===
// 1) Husk kandidatene globalt uansett (i tilfelle kart ikke er lastet ennå)
window.__SSO_MAP_PENDING_STORES = candidates.map(s => ({
  id: s.id || s.storeId || s.slug || `${s.group || 'store'}:${s.name || 'noname'}`,
  name: s.name || s.displayName || '',
  group: s.group || s.chain || s.storeGroup || '',
  lat: s.lat ?? s.latitude ?? (s.location && s.location.lat),
  lng: s.lng ?? s.longitude ?? (s.location && s.location.lng),
  isPhysical: !!(s.isPhysical ?? s.physical ?? s.storeType === 'physical'),
  isOnline: !!(s.isOnline ?? s.online ?? s.storeType === 'online')
}));

// 2) Hvis kart-API allerede finnes, mat det direkte
try {
  if (window.SSO_MAP && typeof window.SSO_MAP.feed === 'function') {
    window.SSO_MAP.feed(window.__SSO_MAP_PENDING_STORES);
  }
} catch (e) {
  console.warn('[SSO][multistore->map] feed() feilet (ikke kritisk):', e);
}

// (valgfritt) enkel diagnose i konsollen:
console.debug('[SSO][multistore] kandidater:',
  { total: candidates.length,
    withCoords: window.__SSO_MAP_PENDING_STORES.filter(x => typeof x.lat === 'number' && typeof x.lng === 'number').length
  }
);
// === SLUTT KOBLING ===

      });
      if (candidates.length) {
        candidates.sort((a, b) => {
          const ap = (typeof a.price === "number") ? a.price : Infinity;
          const bp = (typeof b.price === "number") ? b.price : Infinity;
          return ap - bp;
        });
        const best = candidates[0];
        if (typeof best.price === "number" && isFinite(best.price)) {
          sum += best.price; found += 1;
          details.push({ ean, price: best.price, store_id: best.store_id, group: best.group, isOnline: !!best.isOnline });
        }
      } else {
        details.push({ ean, price: null });
      }
    });
    return { found, total: sum, lines: details };
  }

  function rankScore(total, coverage, COVERAGE_WEIGHT) {
    const weight = (typeof COVERAGE_WEIGHT === "number") ? COVERAGE_WEIGHT : 0;
    const safeTotal = (typeof total === "number") ? total : 0;
    return safeTotal + (1 - coverage) * weight;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderPanel(root) {
    root.innerHTML = `
      <div class="ms-wrap" role="region" aria-labelledby="ms-title">
        <div class="ms-head">
          <h2 id="ms-title">Prisoversikt (flere butikker)</h2>
          <p class="ms-sub">Velg radius. Fysiske butikker tas med kun hvis aktivert og posisjon er godkjent.</p>
        </div>

        <form class="ms-controls" id="ms-form">
          <div class="ms-field ms-switch-box">
            <div class="ms-switch-label">Inkluder fysiske butikker</div>
            <button id="ms-phy-switch" type="button" class="ms-switch ms-switch--off" aria-pressed="false">Av</button>
          </div>

          <div class="ms-field">
            <label for="ms-radius-range">Butikker innenfor radius (km)</label>
            <div class="ms-range">
              <input id="ms-radius-range" type="range" min="5" max="50" step="5" value="10"
                     aria-label="Radius i kilometer" aria-valuetext="10 kilometer">
              <div class="ms-scale" aria-hidden="true">
                <span>5</span><span>10</span><span>15</span><span>20</span><span>25</span>
                <span>30</span><span>35</span><span>40</span><span>45</span><span>50</span>
              </div>
            </div>
          </div>

          <div class="ms-actions">
            <button id="ms-run" type="submit" class="btn">Finn beste butikker</button>
          </div>
        </form>

        <div class="ms-status" aria-live="polite" aria-atomic="true"></div>
        <div class="ms-results" id="ms-results"></div>
      </div>
    `;
  }

  function renderResults(container, rows) {
    if (!rows.length) { container.innerHTML = `<div class="ms-empty">Ingen kandidater å vise.</div>`; return; }
    const top3 = rows.slice(0, 3);
    container.innerHTML = top3.map((r, i) => `
      <article class="ms-item" data-rank="${i + 1}">
        <header class="ms-item-head">
          <div class="ms-rank">#${i + 1}</div>
          <div class="ms-name">
            <div class="ms-store">${r.name}</div>
            <div class="ms-meta">${r.group}${r.isPhysical ? " Â· fysisk" : " Â· nett"}</div>
          </div>
          <div class="ms-total" aria-label="Total">${formatNOK(r.itemsTotal)}</div>
        </header>
        <dl class="ms-breakdown">
          <div><dt>Varer</dt><dd>${formatNOK(r.itemsTotal)}</dd></div>
          <div><dt>Dekning</dt><dd>${Math.round(r.coverage * 100)}%</dd></div>
        </dl>
        <button class="ms-details-btn" aria-expanded="false" aria-controls="ms-det-${i}">Vis detaljer</button>
        <pre id="ms-det-${i}" class="ms-details" hidden>${escapeHtml(JSON.stringify(
          { store: { id: r.id, group: r.group, name: r.name, isPhysical: r.isPhysical }, itemsTotal: r.itemsTotal, coverage: r.coverage, lines: r.lines }, null, 2
        ))}</pre>
      </article>
    `).join("");

    container.querySelectorAll(".ms-details-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("aria-controls");
        const pre = container.querySelector(`#${id}`);
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
        pre.hidden = expanded;
      });
    });
    container.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        container.querySelectorAll(".ms-details").forEach((p) => (p.hidden = true));
        container.querySelectorAll(".ms-details-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
      }
    });
  }

  function init() {
    const panel = q(SEL.panel) || (() => { const sec = document.createElement("section"); sec.id = "multistore-panel"; sec.className = "card"; document.body.appendChild(sec); return sec; })();
    renderPanel(panel);

    const status = q(".ms-status", panel);
    const results = q("#ms-results", panel);
    const form = q("#ms-form", panel);
    const rangeEl = q("#ms-radius-range", panel);
    const phySwitch = q("#ms-phy-switch", panel);

    rangeEl.addEventListener("input", () => rangeEl.setAttribute("aria-valuetext", `${rangeEl.value} kilometer`));
    phySwitch.addEventListener("click", () => {
      const on = phySwitch.getAttribute("aria-pressed") === "true";
      const next = !on;
      phySwitch.setAttribute("aria-pressed", String(next));
      phySwitch.classList.toggle("ms-switch--on", next);
      phySwitch.classList.toggle("ms-switch--off", !next);
      phySwitch.textContent = next ? "På" : "Av";
    });

    async function run(ev) {
      if (ev) ev.preventDefault();
      results.innerHTML = "";
      status.textContent = "Forbereder...";

      let hooks; try { hooks = getHooks(); } catch (e) { status.textContent = e.message; return; }

      const constants = hooks.getConstants();
      const MIN_COVERAGE = (typeof constants.MIN_COVERAGE === "number") ? constants.MIN_COVERAGE : 0.6;
      const COVERAGE_WEIGHT = (typeof constants.COVERAGE_WEIGHT === "number") ? constants.COVERAGE_WEIGHT : 50;

      const scopeIn = normalizeScope(hooks.getScope());           // "online" | "physical" | "all"
      const scopeForApi = scopeIn;
      const includePhysical = (scopeIn === "physical")
        ? true
        : (phySwitch.getAttribute("aria-pressed") === "true" && scopeIn !== "online");

      const eans = (hooks.getCartEans() || []).filter(Boolean);
      // ==== Snapshot-logging (legg inn her) ====
      console.debug('[EAN snapshot]', JSON.parse(JSON.stringify(eans)));
      // ==========================================
      if (!eans.length) { status.textContent = "Handlelista er tom eller EAN ble ikke funnet i adapter."; return; }

      const preferredOn = hooks.preferredOnlyActive();
      const preferredGroups = hooks.getPreferredGroups() || [];
      const groupCSV = (preferredOn && preferredGroups.length > 0)
        ? preferredGroups.map(s => String(s || "").toUpperCase()).join(",")
        : "";

      status.textContent = "Henter priser...";
      const offersMap = await hydrateOffersForEans(eans, scopeForApi, groupCSV, (ean) => hooks.getPricesForEan(ean));
      const getOffersFn = (ean) => offersMap.has(ean) ? offersMap.get(ean) : (Array.isArray(hooks.getPricesForEan(ean)) ? hooks.getPricesForEan(ean) : []);

      // Online kandidater (fra tilbud)
      const onlineCandidatesByGroup = new Map();
      if (scopeIn !== "physical") {
        eans.forEach((ean) => {
          const offers = getOffersFn(ean) || [];
          for (let i = 0; i < offers.length; i++) {
            const off = offers[i];
            const isOnline = (off && (off.isOnline === true || hooks.isOnlineStore(off.store_id || off.group)));
            if (!isOnline) continue;
            if (preferredOn && preferredGroups.length > 0 && off.group && !preferredGroups.includes(off.group)) continue;
            if (off.group) {
              onlineCandidatesByGroup.set(off.group, {
                id: (off.store_id ? off.store_id : off.group),
                name: (off.store_name ? off.store_name : off.group),
                group: off.group,
                isPhysical: false
              });
            }
          }
        });
      }

      // Fysiske kandidater: prøv radius â†’ hvis tomt, fall tilbake til kjeder fra tilbud (uten radius)
      let physicalCandidates = [];
      let usedRadius = false;
      if (includePhysical) {
        status.textContent = "Henter fysiske butikkerâ€¦";
        const origin = await requestPositionIfNeeded(true, scopeIn);
        if (!origin) {
          status.textContent = "Posisjon avslått/feilet. Viser kun nettbutikker.";
        } else {
          const radiusKm = clamp(parseFloat(rangeEl.value || "10"), 5, 50);
          try {
            const { stores } = await fetchNearbyStores(origin, radiusKm, groupCSV);
            usedRadius = Array.isArray(stores) && stores.length > 0;
            if (usedRadius) {
              physicalCandidates = (stores || []).map((s) => {
                const lat = Number.parseFloat(s.position?.lat ?? s.latitude ?? s.location?.lat);
                const lng = Number.parseFloat(s.position?.lng ?? s.longitude ?? s.location?.lng);
                return {
                  id: (s.id !== undefined) ? s.id : ((s.group !== undefined) ? s.group : s.name),
                  name: s.name,
                  group: s.group,
                  lat: Number.isFinite(lat) ? lat : undefined,
                  lng: Number.isFinite(lng) ? lng : undefined,
                  position: s.position,
                  location: s.location,
                  isPhysical: true
                };
              });
            } else {
              // Fallback: kjede-baserte kandidater fra tilbud (uten radius)
              const seen = new Set();
              eans.forEach((ean) => {
                const offers = getOffersFn(ean) || [];
                offers.forEach((o) => {
                  if (o && o.group && !o.isOnline) {
                    if (preferredOn && preferredGroups.length > 0 && !preferredGroups.includes(o.group)) return;
                    if (!seen.has(o.group)) {
                      seen.add(o.group);
                      physicalCandidates.push({
                        id: o.group,
                        name: o.store_name || o.group,
                        group: o.group,
                        isPhysical: true
                      });
                    }
                  }
                });
              });
            }
          } catch {
            // Ved feil: fallback til kjede-baserte kandidater
            const seen = new Set();
            eans.forEach((ean) => {
              const offers = getOffersFn(ean) || [];
              offers.forEach((o) => {
                if (o && o.group && !o.isOnline) {
                  if (preferredOn && preferredGroups.length > 0 && !preferredGroups.includes(o.group)) return;
                  if (!seen.has(o.group)) {
                    seen.add(o.group);
                    physicalCandidates.push({
                      id: o.group,
                      name: o.store_name || o.group,
                      group: o.group,
                      isPhysical: true
                    });
                  }
                }
              });
            });
          }
        }
      }

      // Kombiner etter scope
      let candidates = [];
      if (scopeIn === "online") {
        candidates = Array.from(onlineCandidatesByGroup.values());
      } else if (scopeIn === "physical") {
        candidates = physicalCandidates;
      } else {
        candidates = includePhysical
          ? [...physicalCandidates, ...Array.from(onlineCandidatesByGroup.values())]
          : Array.from(onlineCandidatesByGroup.values());
      }

      // Debug: Sjekk kandidater med koordinater (robust snapshot)
      console.debug('[SSO][multistore] candidates snapshot:', {
        total: candidates.length,
        withCoords: candidates.filter(s =>
          Number.isFinite(s.lat ?? s.latitude ?? s.location?.lat) &&
          Number.isFinite(s.lng ?? s.longitude ?? s.location?.lng)
        ).length
      });

      if (!candidates.length) {
        status.textContent = "Fant ingen kandidater i gjeldende scope/preferanser.";
        results.innerHTML = "";
        return;
      }

      const rows = candidates.map((c) => {
        const sum = summarizeStoreTotalForEans(c, eans, getOffersFn);
        const coverage = eans.length ? (sum.found / eans.length) : 0;
        const score = rankScore((typeof sum.total === 'number' ? sum.total : 0), coverage, COVERAGE_WEIGHT);
        const normalized = normalizeStoreForMap(c);
        const storeId = canonicalStoreId(c);
        return {
          id: storeId,
          name: c.name || c.group || 'Ukjent',
          group: c.group || '',
          isPhysical: !!(c.isPhysical ?? c.physical ?? c.storeType === 'physical'),
          itemsTotal: (typeof sum.total === 'number' ? sum.total : 0),
          coverage,
          score,
          lines: sum.lines,
          lat: normalized?.lat,
          lng: normalized?.lng
        };
      });
      rows.sort((a, b) => a.score - b.score || b.coverage - a.coverage);
      const filtered = rows.filter((r) => r.coverage >= (typeof MIN_COVERAGE === 'number' ? MIN_COVERAGE : 0.0));

      status.textContent = usedRadius
        ? 'Summerer varer...'
        : (includePhysical ? 'Merk: kunne ikke hente butikkposisjoner fra API - viser kjedekandidater (uten radius).' : '');

      const displayRows = filtered.length ? filtered : rows;
      renderResults(results, displayRows);

      await updateMapMarkers({
        candidates,
        displayRows,
        includePhysical,
        scopeIn,
        groupCSV,
        preferredOn,
        preferredGroups,
        rangeEl
      });
    }

    form.addEventListener('submit', run);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
