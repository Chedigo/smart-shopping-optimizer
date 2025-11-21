// Proxy til Kassalapp /api/v1/physical-stores
// Leser nøkkel fra flere mulige env-navn og default'er km=10

function readApiKey() {
  const names = ['KASSALAPP_TOKEN', 'KASSALAPP_KEY', 'KASsALAPP_KEY', 'KASSALAPP_API_KEY'];
  for (const n of names) if (process.env[n]?.trim()) return process.env[n];
  const lower = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n.toLowerCase()]?.trim()) return lower[n.toLowerCase()];
  return null;
}

export async function handler(event) {
  try {
    const q = event.queryStringParameters || {};
    const lat  = Number.parseFloat(q.lat);
    const lng  = Number.parseFloat(q.lng);
    let   km   = Number.parseFloat(q.km);
    const size = q.size ? String(q.size) : '100';

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(400, { error: 'lat & lng må være tall' });
    }
    if (!Number.isFinite(km) || km <= 0) km = 10;

    const API_KEY = readApiKey();
    if (!API_KEY) return json(401, { error: 'Missing Kassalapp API key in env (try KASSALAPP_KEY or KASSALAPP_TOKEN)' });

    const url = `https://kassal.app/api/v1/physical-stores?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&km=${encodeURIComponent(km)}&size=${encodeURIComponent(size)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const text = await r.text();
    return { statusCode: r.status, body: text, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } };
  } catch (e) {
    return json(500, { error: 'Server error', details: String(e) });
  }
}

function json(status, obj) {
  return { statusCode: status, body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json' } };
}
