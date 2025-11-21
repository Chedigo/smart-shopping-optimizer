// netlify/functions/kassalapp.js
// Proxy mot Kassalapp API. EAN via /products/ean/:ean, ellers /products?search=
// Krever KASSALAPP_KEY i env. KASSALAPP_API_BASE default: https://kassal.app/api/v1
// Støtter ?scope=all|physical|online (+ valgfri ?group=KIWI,REMA_1000,...)

async function handler(event) {
  const qs = event.queryStringParameters || {};
  if (qs.health) {
    const hasKey = !!process.env.KASSALAPP_KEY;
    return json(200, { ok: true, env: { KASSALAPP_KEY: hasKey ? 'present' : 'missing' } });
  }

  try {
    const qs     = event.queryStringParameters || {};
    const ean    = String(qs.ean || '').trim();
    const q      = String(qs.q   || '').trim();
    const scope  = parseScope(qs.scope); // 'all' | 'physical' | 'online'
    const groups = String(qs.group || '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase());
    const filters = parseAdvancedFilters(qs);
    const searchTerm = q || filters.fallbackQuery;

    const API_BASE = process.env.KASSALAPP_API_BASE || 'https://kassal.app/api/v1';
    const KEY      = process.env.KASSALAPP_KEY;
    if (!KEY) return json(500, { error: 'Missing KASSALAPP_KEY env var' });
    if (!ean && !searchTerm) {
      return json(400, { error: 'Missing search parameters (need ean, q or filters)' });
    }

    let raw = [];

    if (ean) {
      const url = `${API_BASE}/products/ean/${encodeURIComponent(ean)}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
        cache: 'no-store'
      });

      if (r.status === 404) {
        raw = [];
      } else if (!r.ok) {
        const text = await r.text().catch(() => '');
        return json(r.status, { error: `Upstream ${r.status}`, detail: text.slice(0, 500) });
      } else {
        const data = await r.json();
        const one = (data && (data.data || data));
        if (one && Array.isArray(one.products)) raw = one.products;
        else if (one) raw = [one];
      }

      // Hvis kjedefilter er spesifisert, behold bare matchende
      if (groups.length) {
        raw = raw.filter(p => {
          const code = p?.store?.code || p?.store?.group || p?.group || '';
          return groups.includes(String(code).toUpperCase());
        });
      }
    } else {
      const effectiveQuery = searchTerm;
      if (!effectiveQuery && !filters.hasAny) {
        return json(200, { query: '', count: 0, appliedFilters: filters.exposed, items: [] });
      }

      const limit = clampInt(filters.limit ?? 10, 1, 40);
      filters.limit = limit;

      const u = new URL(`${API_BASE}/products`);
      if (effectiveQuery) u.searchParams.set('search', effectiveQuery);
      u.searchParams.set('size', String(limit));   // kontrollert grense for autocomplete/resultat
      u.searchParams.set('unique', '1');
      u.searchParams.set('exclude_without_ean', '1');
      if (groups.length) u.searchParams.set('group', groups.join(','));
      if (filters.category) u.searchParams.set('category', filters.category);
      if (filters.subcategory) u.searchParams.set('subcategory', filters.subcategory);
      if (filters.brand) u.searchParams.set('brand', filters.brand);

      const r = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
        cache: 'no-store'
      });

      if (r.status === 422) return json(200, { query: effectiveQuery || '', count: 0, appliedFilters: filters.exposed, items: [] });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return json(r.status, { error: `Upstream ${r.status}`, detail: text.slice(0, 500) });
      }
      const data = await r.json();
      raw = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    }

    // Normaliser
    let list = raw.map((p) => {
      const packageInfo = derivePackageInfo(p);
      const size = packageInfo.raw ?? '';
      const eanOut = p?.ean || ean || '';

      const price =
        (p && typeof p.current_price === 'object' && p.current_price !== null && typeof p.current_price.price === 'number')
          ? p.current_price.price
          : (
              (typeof p?.current_price === 'number')
                ? p.current_price
                : (
                    (p && typeof p.price === 'object' && p.price !== null && typeof p.price.current === 'number')
                      ? p.price.current
                      : (
                          (typeof p?.currentPrice === 'number')
                          ? p.currentPrice
                          : ((typeof p?.price === 'number') ? p.price : null)
                        )
                  )
            );

      const unitPricing = deriveUnitPricing(p, price, packageInfo);

      const storeRaw = p?.store?.name ?? p?.storeName ?? p?.store ?? p?.retailer ?? null;
      const groupRaw = p?.store?.group ?? p?.group ?? p?.store?.code ?? null;

      const { store, group } = canonicalizeStore(storeRaw, groupRaw);

      const categoryInfo = extractCategoryInfo(p);
      const tags = extractTags(p);
      const normalizedTags = normalizeTags(tags);
      const attributes = deriveAttributesFromProduct(p, normalizedTags, packageInfo);

      const pricePerKg = Number.isFinite(unitPricing.pricePerKg)
        ? unitPricing.pricePerKg
        : (
            Number.isFinite(packageInfo.kilograms) && packageInfo.kilograms > 0 && Number.isFinite(price)
              ? price / packageInfo.kilograms
              : null
          );

      const pricePerLiter = Number.isFinite(unitPricing.pricePerLiter)
        ? unitPricing.pricePerLiter
        : (
            Number.isFinite(packageInfo.liters) && packageInfo.liters > 0 && Number.isFinite(price)
              ? price / packageInfo.liters
              : null
          );

      return {
        id:        p?.id ?? p?.productId ?? null,
        name:      p?.name ?? '',
        brand:     p?.brand ?? '',
        ean:       eanOut,
        size:      size,
        price:     price,
        store:     store,
        group:     group,
        updatedAt: p?.updatedAt ?? p?.price?.updatedAt ?? null,
        category: categoryInfo.category,
        subcategory: categoryInfo.subcategory,
        categories: categoryInfo.categories,
        subcategories: categoryInfo.subcategories,
        tags,
        tagsNormalized: normalizedTags,
        attributes,
        packageInfo,
        unitPricing,
        pricePerKg: Number.isFinite(pricePerKg) ? pricePerKg : null,
        pricePerLiter: Number.isFinite(pricePerLiter) ? pricePerLiter : null
      };
    });

    // Filtrer etter scope
    if (scope !== 'all') {
      list = list.filter((it) => {
        const online = isOnlineStore(it.store, it.group);
        return scope === 'online' ? online : !online; // physical
      });
    }

    list = filterResultsByAdvanced(list, filters);
    if (typeof filters.limit === 'number' && Number.isFinite(filters.limit)) {
      list = list.slice(0, filters.limit);
    }

    // Laveste pris (på filtrert liste)
    let best = null;
    for (const it of list) {
      if (typeof it.price === 'number') {
        if (!best || it.price < best.price) best = it;
      }
    }

    return json(200, {
      query: ean || q || filters.fallbackQuery || '',
      count: list.length,
      scope,
      appliedFilters: filters.exposed,
      bestPrice: best,
      items: list
    });
  } catch (err) {
    return json(502, { error: 'Function failed', detail: String(err) });
  }
}

// ——— helpers ———
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

function parseScope(s) {
  const v = String(s || 'all').toLowerCase();
  return (v === 'online' || v === 'physical') ? v : 'all';
}

// Nettbutikker (Oda/Kolonial m.m.)
function isOnlineStore(store, group) {
  const hay = `${store || ''} ${group || ''}`.toLowerCase();
  return /(oda|kolonial|kolonial\.no|nettbutikk|online)/i.test(hay);
}

function deriveUnitPricing(product, price, packageInfo) {
  const candidates = gatherUnitPriceCandidates(product);
  for (const entry of candidates) {
    const parsed = normalizeUnitPriceFromObject(entry.obj, entry.source);
    if (parsed) return parsed;
  }

  const kilograms = Number.isFinite(packageInfo?.kilograms) ? packageInfo.kilograms : null;
  const liters = Number.isFinite(packageInfo?.liters) ? packageInfo.liters : null;
  const fallbackPricePerKg = (Number.isFinite(price) && Number.isFinite(kilograms) && kilograms > 0)
    ? price / kilograms
    : null;
  const fallbackPricePerLiter = (Number.isFinite(price) && Number.isFinite(liters) && liters > 0)
    ? price / liters
    : null;

  return {
    value: null,
    quantity: null,
    unit: packageInfo?.unit ?? null,
    unitRaw: packageInfo?.unitRaw ?? null,
    display: null,
    pricePerUnit: null,
    pricePerKg: Number.isFinite(fallbackPricePerKg) ? fallbackPricePerKg : null,
    pricePerLiter: Number.isFinite(fallbackPricePerLiter) ? fallbackPricePerLiter : null,
    source: packageInfo?.unit ? 'fallback-package' : null
  };
}

function gatherUnitPriceCandidates(product) {
  const candidates = [];
  if (product && typeof product === 'object') {
    if (product.current_price && typeof product.current_price === 'object') {
      candidates.push({ source: 'current_price', obj: product.current_price });
    }
    if (product.price && typeof product.price === 'object' && product.price !== product.current_price) {
      candidates.push({ source: 'price', obj: product.price });
    }
    if (product.pricing && typeof product.pricing === 'object') {
      candidates.push({ source: 'pricing', obj: product.pricing });
    }
    if (product.currentPrice && typeof product.currentPrice === 'object') {
      candidates.push({ source: 'currentPrice', obj: product.currentPrice });
    }
  }
  return candidates;
}

function normalizeUnitPriceFromObject(obj, source) {
  if (!obj || typeof obj !== 'object') return null;

  let value = safeNumber(
    obj.unit_price ?? obj.unitPrice ?? obj.price_per_unit ?? obj.pricePerUnit ?? obj.value ?? obj.amount ?? obj.price
  );

  let quantity = safeNumber(
    obj.unit_quantity ?? obj.unitQuantity ?? obj.unit_qty ?? obj.unit_price_quantity ?? obj.quantity ?? obj.unit?.quantity
  );

  let unitRaw = firstString(
    obj.unit_price_unit,
    obj.unitPriceUnit,
    obj.unit_unit,
    obj.unit,
    obj.unit_name,
    obj.unit?.name,
    obj.unit?.unit
  );

  let display = firstString(
    obj.unit_price_text,
    obj.unitPriceText,
    obj.unit_price_display,
    obj.unitPriceDisplay,
    obj.price_per_unit_text,
    obj.pricePerUnitText,
    obj.unit_price_pretty,
    obj.unit_price_formatted,
    obj.unit?.display
  );

  if (!Number.isFinite(value)) {
    const formattedCandidates = [
      obj.unit_price_formatted,
      obj.unitPriceFormatted,
      obj.price_per_unit_formatted,
      obj.pricePerUnitFormatted,
      obj.unit_price_string,
      obj.price_per_unit_string,
      display
    ];
    for (const candidate of formattedCandidates) {
      const num = extractNumberFromString(candidate);
      if (Number.isFinite(num)) {
        value = num;
        if (!display && candidate) display = String(candidate).trim();
        if (!unitRaw) {
          const m = String(candidate || '').match(/\/\s*([a-zA-Z]+)/);
          if (m) unitRaw = m[1];
        }
        break;
      }
    }
  }

  if (!Number.isFinite(value)) return null;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    quantity = safeNumber(obj.unit_price_qty ?? obj.unitPriceQty ?? obj.unitQuantityValue);
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
  }

  let unit = normalizeUnit(unitRaw);
  if (!unit && obj.unit && typeof obj.unit === 'object') {
    unit = normalizeUnit(obj.unit.unit ?? obj.unit.name ?? obj.unit.type);
  }
  if (!unit && display) {
    const m = display.match(/\/\s*([a-zA-Z]+)/);
    if (m) unit = normalizeUnit(m[1]);
  }

  const pricePerUnit = value / quantity;
  const pricePerKg = computePricePerKg(pricePerUnit, unit);
  const pricePerLiter = computePricePerLiter(pricePerUnit, unit);

  return {
    value,
    quantity,
    unit,
    unitRaw: unitRaw ? String(unitRaw).trim() : null,
    display: display ?? null,
    pricePerUnit: Number.isFinite(pricePerUnit) ? pricePerUnit : null,
    pricePerKg: Number.isFinite(pricePerKg) ? pricePerKg : null,
    pricePerLiter: Number.isFinite(pricePerLiter) ? pricePerLiter : null,
    source
  };
}

function derivePackageInfo(product) {
  const rawCandidates = [
    product?.size,
    product?.size_text,
    product?.sizeText,
    product?.packageSize,
    product?.package_size,
    product?.package,
    product?.packaging,
    product?.item_size,
    product?.itemSize,
    product?.unit_size,
    product?.unitSize
  ];
  const raw = rawCandidates.find((val) => typeof val === 'string' && val.trim().length > 0) || null;

  const parsed = parseSizeString(raw);

  const weightValue = safeNumber(
    product?.weight ?? product?.net_weight ?? product?.netWeight ?? product?.package_weight ?? product?.packageWeight
  );
  const weightUnit = normalizeUnit(
    firstString(
      product?.weight_unit,
      product?.weightUnit,
      product?.weight?.unit,
      product?.weight?.unit_name,
      product?.weight?.measurement
    )
  );

  let quantity = parsed?.quantity;
  let unit = parsed?.unit;
  let unitRaw = parsed?.unitRaw ?? (raw ? String(raw).trim() : null);

  if (!Number.isFinite(quantity) && Number.isFinite(weightValue)) {
    quantity = weightValue;
    unit = weightUnit || unit;
  }

  if (!unit && weightUnit) unit = weightUnit;

  const kilograms = computeKilograms(quantity, unit);
  const liters = computeLiters(quantity, unit);

  return {
    raw: raw ?? (Number.isFinite(quantity) && unit ? `${quantity} ${unit}` : null),
    quantity: Number.isFinite(quantity) ? quantity : null,
    unit,
    unitRaw,
    kilograms: Number.isFinite(kilograms) ? kilograms : null,
    liters: Number.isFinite(liters) ? liters : null
  };
}

function parseSizeString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();
  const normalized = text.replace(',', '.').toLowerCase();

  const multi = normalized.match(/([\d.]+)\s*[x×]\s*([\d.]+)\s*(kg|g|hg|mg|l|dl|cl|ml|stk|pk|pack|pakke)/i);
  if (multi) {
    const count = safeNumber(multi[1]);
    const amount = safeNumber(multi[2]);
    const unit = normalizeUnit(multi[3]);
    if (Number.isFinite(count) && Number.isFinite(amount)) {
      return {
        raw: text,
        quantity: count * amount,
        unit,
        unitRaw: multi[3]
      };
    }
  }

  const single = normalized.match(/([\d.]+)\s*(kg|g|hg|mg|l|dl|cl|ml|stk|pk|pack|pakke)/i);
  if (single) {
    const qty = safeNumber(single[1]);
    const unit = normalizeUnit(single[2]);
    if (Number.isFinite(qty)) {
      return {
        raw: text,
        quantity: qty,
        unit,
        unitRaw: single[2]
      };
    }
  }

  const pieces = normalized.match(/(\d+)\s*(stk|st|pieces|pk|pack|pakke)/i);
  if (pieces) {
    const qty = safeNumber(pieces[1]);
    if (Number.isFinite(qty)) {
      return {
        raw: text,
        quantity: qty,
        unit: 'stk',
        unitRaw: pieces[2]
      };
    }
  }

  return {
    raw: text,
    quantity: null,
    unit: null,
    unitRaw: null
  };
}

function safeNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
    if (!normalized) return null;
    const n = Number.parseFloat(normalized[0]);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

function extractNumberFromString(str) {
  if (!str) return null;
  const match = String(str).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0]);
  return Number.isFinite(num) ? num : null;
}

function normalizeUnit(unit) {
  if (!unit) return null;
  const map = {
    kilogram: 'kg',
    kilograms: 'kg',
    kilo: 'kg',
    kg: 'kg',
    gram: 'g',
    grams: 'g',
    g: 'g',
    hektogram: 'hg',
    hektogrammer: 'hg',
    hg: 'hg',
    milligram: 'mg',
    milligrams: 'mg',
    mg: 'mg',
    liter: 'l',
    litre: 'l',
    liters: 'l',
    litres: 'l',
    l: 'l',
    deciliter: 'dl',
    decilitre: 'dl',
    dl: 'dl',
    centiliter: 'cl',
    centilitre: 'cl',
    cl: 'cl',
    milliliter: 'ml',
    millilitre: 'ml',
    ml: 'ml',
    stk: 'stk',
    st: 'stk',
    pieces: 'stk',
    piece: 'stk',
    pk: 'stk',
    pack: 'stk',
    pakke: 'stk',
    pose: 'stk',
    lbs: 'lb',
    lb: 'lb',
    ounce: 'oz',
    ounces: 'oz',
    oz: 'oz'
  };
  const key = String(unit).trim().toLowerCase();
  return map[key] || key;
}

function computePricePerKg(pricePerUnit, unit) {
  if (!Number.isFinite(pricePerUnit)) return null;
  switch (unit) {
    case 'kg': return pricePerUnit;
    case 'g': return pricePerUnit * 1000;
    case 'hg': return pricePerUnit * 10;
    case 'mg': return pricePerUnit * 1_000_000;
    case 'lb': return pricePerUnit * 2.20462262185;
    case 'oz': return pricePerUnit * 35.27396195;
    default: return null;
  }
}

function computePricePerLiter(pricePerUnit, unit) {
  if (!Number.isFinite(pricePerUnit)) return null;
  switch (unit) {
    case 'l': return pricePerUnit;
    case 'dl': return pricePerUnit * 10;
    case 'cl': return pricePerUnit * 100;
    case 'ml': return pricePerUnit * 1000;
    default: return null;
  }
}

function computeKilograms(quantity, unit) {
  if (!Number.isFinite(quantity)) return null;
  switch (unit) {
    case 'kg': return quantity;
    case 'g': return quantity / 1000;
    case 'hg': return quantity / 10;
    case 'mg': return quantity / 1_000_000;
    case 'lb': return quantity * 0.45359237;
    case 'oz': return quantity * 0.0283495231;
    default: return null;
  }
}

function computeLiters(quantity, unit) {
  if (!Number.isFinite(quantity)) return null;
  switch (unit) {
    case 'l': return quantity;
    case 'dl': return quantity / 10;
    case 'cl': return quantity / 100;
    case 'ml': return quantity / 1000;
    default: return null;
  }
}

function firstString(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function parseAdvancedFilters(qs) {
  if (!qs || typeof qs !== 'object') {
    return {
      category: null,
      subcategory: null,
      brand: null,
      tags: [],
      lactoseFree: false,
      fatMin: null,
      fatMax: null,
      sizeMode: 'auto',
      sizeMin: null,
      sizeMax: null,
      originalSizeMin: null,
      originalSizeMax: null,
      fallbackQuery: '',
      hasAny: false,
      limit: null,
      exposed: {}
    };
  }

  const category = safeString(qs.category ?? qs.categories);
  const subcategory = safeString(qs.subcategory ?? qs.subCategory ?? qs.sub_category);
  const brand = safeString(qs.brand);
  const tagsCsv = safeString(qs.tags ?? qs.labels ?? qs.attributes);
  const tags = tagsCsv ? tagsCsv.split(',').map((part) => safeString(part)).filter(Boolean) : [];
  const lactoseValue = parseBooleanFlag(qs.lactoseFree ?? qs.lactose_free);
  const fatRange = parseRangeSpec(safeString(qs.fatPct ?? qs.fat_pct));
  const fatMin = firstFinite([safeNumber(qs.fatPctMin ?? qs.fat_min), fatRange?.min]);
  const fatMax = firstFinite([safeNumber(qs.fatPctMax ?? qs.fat_max), fatRange?.max]);
  const sizeFilters = normalizeSizeFilters(
    safeNumber(qs.unitMin ?? qs.sizeMin ?? qs.size_min),
    safeNumber(qs.unitMax ?? qs.sizeMax ?? qs.size_max),
    safeString(qs.unitType ?? qs.sizeUnit ?? qs.size_mode)
  );
  const limitRaw = Number.parseInt(qs.limit ?? qs.size, 10);
  const limit = Number.isFinite(limitRaw) ? clampInt(limitRaw, 1, 50) : null;

  const fallbackTokens = [];
  if (category) fallbackTokens.push(category);
  if (subcategory) fallbackTokens.push(subcategory);
  if (brand) fallbackTokens.push(brand);
  if (lactoseValue === true) fallbackTokens.push('laktosefri');
  if (!fallbackTokens.length && (typeof fatMin === 'number' || typeof fatMax === 'number')) {
    fallbackTokens.push('fett');
  }
  const fallbackQuery = fallbackTokens.join(' ').trim();

  const hasAny = Boolean(
    category ||
    subcategory ||
    brand ||
    tags.length ||
    lactoseValue === true ||
    typeof fatMin === 'number' ||
    typeof fatMax === 'number' ||
    typeof sizeFilters.min === 'number' ||
    typeof sizeFilters.max === 'number'
  );

  const exposed = buildExposedFilterObject({
    category,
    subcategory,
    brand,
    tags,
    lactoseFree: lactoseValue === true ? true : null,
    fatMin: typeof fatMin === 'number' ? fatMin : null,
    fatMax: typeof fatMax === 'number' ? fatMax : null,
    sizeMode: sizeFilters.mode !== 'auto' ? sizeFilters.mode : null,
    sizeMin: sizeFilters.originalMin,
    sizeMax: sizeFilters.originalMax
  });
  if (limit) exposed.limit = limit;

  return {
    category,
    subcategory,
    brand,
    tags,
    lactoseFree: lactoseValue === true,
    fatMin: typeof fatMin === 'number' ? fatMin : null,
    fatMax: typeof fatMax === 'number' ? fatMax : null,
    sizeMode: sizeFilters.mode,
    sizeMin: typeof sizeFilters.min === 'number' ? sizeFilters.min : null,
    sizeMax: typeof sizeFilters.max === 'number' ? sizeFilters.max : null,
    originalSizeMin: sizeFilters.originalMin,
    originalSizeMax: sizeFilters.originalMax,
    fallbackQuery,
    hasAny,
    limit,
    exposed
  };
}

function buildExposedFilterObject(source) {
  const out = {};
  Object.entries(source).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === 'boolean' && value === false) return;
    out[key] = value;
  });
  return out;
}

function parseRangeSpec(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parts = normalized.split('-').map((part) => safeNumber(part));
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return { min: parts[0], max: parts[1] };
  }
  const single = safeNumber(normalized);
  if (Number.isFinite(single)) return { min: single, max: single };
  return null;
}

function normalizeSizeFilters(minRaw, maxRaw, modeRaw) {
  const mode = normalizeSizeMode(modeRaw);
  const min = Number.isFinite(minRaw) ? minRaw : null;
  const max = Number.isFinite(maxRaw) ? maxRaw : null;
  return {
    mode,
    min,
    max,
    originalMin: min,
    originalMax: max
  };
}

function normalizeSizeMode(modeRaw) {
  const value = String(modeRaw || '').trim().toLowerCase();
  if (!value) return 'auto';
  if (['volume', 'vol', 'liter', 'litre', 'l'].includes(value)) return 'volume';
  if (['mass', 'weight', 'kg', 'g', 'gram', 'grams', 'kilogram'].includes(value)) return 'mass';
  return 'auto';
}

function filterResultsByAdvanced(list, filters) {
  if (!Array.isArray(list) || !filters) return list;
  const needsFiltering =
    filters.hasAny ||
    filters.lactoseFree ||
    typeof filters.fatMin === 'number' ||
    typeof filters.fatMax === 'number' ||
    typeof filters.sizeMin === 'number' ||
    typeof filters.sizeMax === 'number';
  if (!needsFiltering) return list;
  return list.filter((item) => matchesAdvancedFilters(item, filters));
}

function matchesAdvancedFilters(item, filters) {
  if (!item || typeof item !== 'object') return false;
  if (filters.category) {
    const catMatch = includesInsensitive(item.categories, filters.category) || includesInsensitive(item.category, filters.category);
    if (!catMatch) return false;
  }
  if (filters.subcategory) {
    const subMatch =
      includesInsensitive(item.subcategories, filters.subcategory) ||
      includesInsensitive(item.categories, filters.subcategory) ||
      includesInsensitive(item.subcategory, filters.subcategory);
    if (!subMatch) return false;
  }
  if (filters.brand && !includesInsensitive(item.brand, filters.brand)) return false;
  if (filters.tags && filters.tags.length) {
    const normalizedTags = getNormalizedTags(item);
    const allMatch = filters.tags.every((tag) => includesInsensitive(normalizedTags, tag));
    if (!allMatch) return false;
  }
  if (filters.lactoseFree) {
    const normalizedTags = getNormalizedTags(item);
    const hasTag = normalizedTags.some((tag) => /laktosefri|lactose[\s-]?free/i.test(tag));
    if (!item.attributes?.lactoseFree && !hasTag) return false;
  }
  const fatPct = typeof item.attributes?.fatPct === 'number' ? item.attributes.fatPct : null;
  if (typeof filters.fatMin === 'number') {
    if (!Number.isFinite(fatPct) || fatPct < filters.fatMin) return false;
  }
  if (typeof filters.fatMax === 'number') {
    if (!Number.isFinite(fatPct) || fatPct > filters.fatMax) return false;
  }
  if (typeof filters.sizeMin === 'number' || typeof filters.sizeMax === 'number') {
    if (!matchesSizeFilter(item, filters)) return false;
  }
  return true;
}

function matchesSizeFilter(item, filters) {
  if (!item?.packageInfo) return false;
  const { kilograms, liters } = item.packageInfo;
  const min = filters.sizeMin;
  const max = filters.sizeMax;
  if (filters.sizeMode === 'volume') {
    if (!Number.isFinite(liters)) return false;
    if (typeof min === 'number' && liters < min) return false;
    if (typeof max === 'number' && liters > max) return false;
    return true;
  }
  if (filters.sizeMode === 'mass') {
    if (!Number.isFinite(kilograms)) return false;
    if (typeof min === 'number' && kilograms < min) return false;
    if (typeof max === 'number' && kilograms > max) return false;
    return true;
  }
  const value = Number.isFinite(liters) ? liters : (Number.isFinite(kilograms) ? kilograms : null);
  if (!Number.isFinite(value)) return false;
  if (typeof min === 'number' && value < min) return false;
  if (typeof max === 'number' && value > max) return false;
  return true;
}

function getNormalizedTags(item) {
  if (Array.isArray(item.tagsNormalized) && item.tagsNormalized.length) return item.tagsNormalized;
  if (Array.isArray(item.tags)) return normalizeTags(item.tags);
  return [];
}

function extractCategoryInfo(product) {
  const categories = new Set();
  const subcategories = new Set();
  const push = (value, targetSet) => {
    const str = safeString(value);
    if (str) targetSet.add(str);
  };

  push(product?.category, categories);
  push(product?.category_name, categories);
  push(product?.categoryName, categories);
  push(product?.category?.name, categories);
  if (Array.isArray(product?.categories)) {
    product.categories.forEach((entry) => push(entry?.name ?? entry, categories));
  }

  push(product?.subcategory, subcategories);
  push(product?.sub_category, subcategories);
  push(product?.subcategory?.name, subcategories);
  if (Array.isArray(product?.subcategories)) {
    product.subcategories.forEach((entry) => push(entry?.name ?? entry, subcategories));
  }

  if (Array.isArray(product?.category_path)) {
    product.category_path.forEach((entry, idx) => {
      const str = safeString(entry);
      if (!str) return;
      if (idx === 0) categories.add(str);
      else subcategories.add(str);
    });
  }

  const primaryCategory = categories.values().next().value || null;
  const primarySubcategory = subcategories.values().next().value || null;

  return {
    category: primaryCategory,
    subcategory: primarySubcategory,
    categories: Array.from(categories),
    subcategories: Array.from(subcategories)
  };
}

function extractTags(product) {
  const tags = new Set();
  const add = (value) => {
    const str = safeString(value);
    if (str) tags.add(str);
  };
  const candidates = [
    product?.tags,
    product?.labels,
    product?.attributes?.tags,
    product?.attributes?.labels
  ];
  candidates.forEach((list) => {
    if (Array.isArray(list)) list.forEach(add);
  });
  add(product?.tag);
  add(product?.label);
  return Array.from(tags);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => safeString(tag))
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());
}

function deriveAttributesFromProduct(product, normalizedTags, packageInfo) {
  const lactoseValue = parseBooleanFlag(
    product?.lactose_free ??
    product?.lactoseFree ??
    product?.attributes?.lactoseFree ??
    product?.attributes?.lactose_free
  );
  const lactoseFromTags = normalizedTags?.some((tag) => /laktosefri|lactose[\s-]?free/i.test(tag)) || false;
  const lactoseFree = lactoseValue === true || lactoseFromTags ? true : (lactoseValue === false ? false : null);

  const fatCandidates = [
    safeNumber(product?.fat_pct),
    safeNumber(product?.fatPercentage),
    safeNumber(product?.fat),
    safeNumber(product?.nutrition?.fat),
    safeNumber(product?.nutrition?.fat_pct),
    safeNumber(product?.nutritional_values?.fat),
    safeNumber(product?.nutritional_values?.fat_pct),
    safeNumber(product?.nutritional?.fat),
    safeNumber(product?.fat_content)
  ];
  const fatPct = firstFinite(fatCandidates);

  const organicValue = parseBooleanFlag(
    product?.organic ??
    product?.isOrganic ??
    product?.attributes?.organic ??
    product?.attributes?.isOrganic
  );
  const organicFromTags = normalizedTags?.some((tag) => /økologisk|okologisk|organic|bio|eco/i.test(tag)) || false;

  return {
    lactoseFree: lactoseFree === true,
    fatPct: typeof fatPct === 'number' ? fatPct : null,
    isOrganic: organicValue === true || (organicValue !== false && organicFromTags)
  };
}

function parseBooleanFlag(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function includesInsensitive(collection, needle) {
  const target = safeString(needle);
  if (!target) return false;
  const value = target.toLowerCase();
  if (Array.isArray(collection)) {
    return collection.some((entry) => {
      const str = safeString(entry);
      return str ? str.toLowerCase().includes(value) : false;
    });
  }
  const single = safeString(collection);
  return single ? single.toLowerCase().includes(value) : false;
}

function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function firstFinite(values) {
  const list = Array.isArray(values) ? values : Array.from(arguments);
  for (const value of list) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function safeString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/**
 * NYTT: alias-normalisering for kjeder (dekker Kassalapp sine group-koder + vanlige navn)
 * Kilde: API-dokumentasjon for physical-stores 'group' (ALLTIMAT, BUNNPRIS, COOP_*, EUROPRIS_NO, FUDI, GIGABOKS,
 * HAVARISTEN, JOKER_NO, KIWI, MATKROKEN, MENY_NO, NAERBUTIKKEN, REMA_1000, SPAR_NO). 
 * https://kassal.app/api/docs
 */
function canonicalizeStore(storeIn, groupIn) {
  const s = String(storeIn || '').trim();
  const g = String(groupIn || '').trim();

  const lower = s.toLowerCase();
  const glower = g.toLowerCase();

  // helper
  const ret = (store, group) => ({ store, group });

  // ---- NorgesGruppen / Reitan / Coop + øvrige dagligvareaktører ----
  if (/^kiwi\b/.test(lower) || glower === 'kiwi') return ret('KIWI', 'KIWI');

  if (/rema\s*1000/.test(lower) || glower === 'rema_1000' || glower === 'rema 1000') return ret('REMA 1000', 'REMA_1000');

  if (/(^|\s)meny(\s|$)/.test(lower) || glower === 'meny_no' || glower === 'meny') return ret('MENY', 'MENY_NO');

  if (/^spar\b/i.test(s) || /eurospar/i.test(s) || glower === 'spar_no' || glower === 'eurospar') return ret('SPAR', 'SPAR_NO');

  if (/^joker\b/i.test(s) || glower === 'joker_no' || glower === 'joker') return ret('Joker', 'JOKER_NO');

  if (/^n(æ|ae)rbutikken\b/i.test(s) || glower === 'naerbutikken') return ret('Nærbutikken', 'NAERBUTIKKEN');

  if (/^bunnpris\b/i.test(s) || glower === 'bunnpris') return ret('Bunnpris', 'BUNNPRIS');

  // Coop-familien
  if (/^extra\b/i.test(s) || /coop\s*extra/i.test(s) || glower === 'coop_extra' || glower === 'extra') return ret('Extra', 'COOP_EXTRA');

  if (/^obs\b/i.test(s) || /coop\s*obs/i.test(s) || glower === 'coop_obs' || glower === 'obs') return ret('Obs', 'COOP_OBS');

  if (/obs\s*bygg/i.test(s) || glower === 'coop_obs_bygg') return ret('Obs Bygg', 'COOP_OBS_BYGG');

  if (/^coop\s*mega/i.test(s) || glower === 'coop_mega' || glower === 'mega') return ret('Coop Mega', 'COOP_MEGA');

  if (/^coop\s*marked/i.test(s) || glower === 'coop_marked' || glower === 'marked') return ret('Coop Marked', 'COOP_MARKED');

  if (/^coop\s*prix/i.test(s) || glower === 'coop_prix' || glower === 'prix') return ret('Coop Prix', 'COOP_PRIX');

  // Øvrige kjeder nevnt i API-gruppene
  if (/allti\s*mat/i.test(s) || glower === 'alltimat') return ret('AlltiMat', 'ALLTIMAT');

  if (/matkroken/i.test(s) || glower === 'matkroken') return ret('Matkroken', 'MATKROKEN');

  if (/europris/i.test(s) || glower === 'europris_no' || glower === 'europris') return ret('Europris', 'EUROPRIS_NO');

  if (/havaristen/i.test(s) || glower === 'havaristen') return ret('Havaristen', 'HAVARISTEN');

  if (/gigaboks/i.test(s) || glower === 'gigaboks') return ret('Gigaboks', 'GIGABOKS');

  if (/fudi/i.test(s) || glower === 'fudi') return ret('FUDI', 'FUDI');

  // Nettbutikk (Oda/Kolonial – ikke del av group-listen, men viktig for online scope)
  if (/oda|kolonial/i.test(s) || /(oda|kolonial)/i.test(glower)) return ret('Oda', 'ODA');

  // Fallback: behold originalen
  return ret(s || null, g || null);
}

exports.handler = handler;
exports.__test = {
  deriveUnitPricing,
  derivePackageInfo,
  parseSizeString,
  computePricePerKg,
  computePricePerLiter,
  computeKilograms,
  computeLiters,
  normalizeUnit,
  safeNumber,
  safeString,
  parseAdvancedFilters,
  normalizeSizeFilters,
  filterResultsByAdvanced,
  matchesAdvancedFilters,
  extractCategoryInfo,
  extractTags,
  normalizeTags,
  deriveAttributesFromProduct,
  parseBooleanFlag,
  clampInt,
  firstFinite
};
