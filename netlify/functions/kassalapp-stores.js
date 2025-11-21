
// Proxy til Kassalapp /api/v1/physical-stores
// - Aksepterer radius_km/limit ELLER km/size
// - Leser Kassalapp-nøkkel fra flere env-navn
// - Normaliserer output: beholder original struktur og legger alias "stores"

function readApiKey() {
  const names = ['KASSALAPP_TOKEN', 'KASSALAPP_KEY', 'KASsALAPP_KEY', 'KASSALAPP_API_KEY'];
  for (const n of names) if (process.env[n]?.toString().trim()) return process.env[n];
  const lower = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n.toLowerCase()]?.toString().trim()) return lower[n.toLowerCase()];
  return null;
}

function asFloat(x) {
  const n = Number.parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

export async function handler(event) {
  try {
    const q = event.queryStringParameters || {};

    const lat  = asFloat(q.lat);
    const lng  = asFloat(q.lng);
    // Støtt både radius_km og km
    let km     = asFloat(q.km ?? q.radius_km);
    // Støtt både size og limit
    let size   = Number.parseInt(q.size ?? q.limit ?? '100', 10);
    const group = q.group; // valgfritt kjedefilter (CSV eller enkel verdi)

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(400, { error: 'lat & lng må være tall' });
    }
    if (!Number.isFinite(km) || km <= 0) km = 10;
    if (!Number.isFinite(size) || size <= 0) size = 100;

    const API_KEY = readApiKey();
    if (!API_KEY) {
      return json(401, { error: 'Missing Kassalapp API key in env (try KASSALAPP_KEY or KASSALAPP_TOKEN)' });
    }

    const params = new URLSearchParams({
      lat: String(lat),
      lng: String(lng),
      km: String(km),
      size: String(size)
    });
    if (group) params.append('group', group);

    const upstream = `https://kassal.app/api/v1/physical-stores?${params.toString()}`;
    const r = await fetch(upstream, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const text = await r.text();

    // Prøv å normalisere forsiktig, men bevar originalen
    let body;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        // Hvis responsen allerede har data/meta/links, bare legg til "stores" alias.
        if ('data' in parsed) {
          body = { ...parsed, stores: parsed.data };
        } else if (Array.isArray(parsed)) {
          body = { data: parsed, stores: parsed };
        } else {
          body = parsed;
          if (Array.isArray(parsed.results)) {
            body = { ...parsed, data: parsed.results, stores: parsed.results };
          }
        }
      } else {
        body = parsed;
      }
    } catch {
      // Hvis upstream ikke var JSON (bør ikke skje), pass-through tekst
      return {
        statusCode: r.status,
        body: text,
        headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' }
      };
    }

    return {
      statusCode: r.status,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    };
  } catch (e) {
    return json(500, { error: 'Server error', details: String(e) });
  }
}

function json(status, obj) {
  return { statusCode: status, body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } };
}
