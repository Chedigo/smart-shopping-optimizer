// Klient-wrapper til Netlify Function (ingen secrets her)
// Bruk RELATIV sti til dev-proxy: /.netlify/functions/...
export async function fetchPhysicalStoresNear({ lat, lng, km = 10, size = 100 } = {}) {
  const qs = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    km: String(Number.isFinite(km) && km > 0 ? km : 10),
    size: String(size || 100)
  }).toString();

  const r = await fetch(`/.netlify/functions/kassa-physical-stores?${qs}`);
  if (!r.ok) {
    let info = '';
    try { info = await r.text(); } catch {}
    throw new Error(`Proxy failed: ${r.status} ${info}`);
  }
  const json = await r.json();
  return json?.data || [];
}
