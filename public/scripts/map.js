�/* Smart Shopping Optimizer � Leaflet kartmodul
   - Lazy-laster Leaflet CSS/JS fra CDN ved første init (LCP-vennlig)
   - Viser brukerposisjon on-demand (secure context + avslag håndteres rolig)
   - Tegner butikkpunkter fra multistore-kandidater
   - API: init(containerId), feed(stores), focus({ids,groups}), fitToStores(), setUserLocation(lat,lng), locateUser()
   - Tiles: OSM (policy/URL/anbefalt attribution) � se: https://leafletjs.com/examples/quick-start/
*/

(function () {
  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const INTEGRITY_CSS = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  const INTEGRITY_JS  = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

  // OSM tile URL + attribution (Leaflet Quick Start / OSM policy)
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIB   = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  let map = null;
  let tiles = null;
  let markersLayer = null;
  let userMarker = null;
  let storesIndex = new Map(); // id -> {lat,lng,name,group,isPhysical,isOnline,marker}

  function markerStyleForPriceRank(rank) {
    const stroke = '#5b2d82';
    switch (rank) {
      case 1: return { stroke, fill: '#1f9c7c', opacity: 0.8 };
      case 2: return { stroke, fill: '#2196F3', opacity: 0.8 };
      case 3: return { stroke, fill: '#FFEB3B', opacity: 0.85 };
      default: return { stroke, fill: '#26C6DA', opacity: 0.7 };
    }
  }

  let containerIdMemo = null;
  let __LeafletNS = null; // privat referanse som vi bruker i hele modulen
  let leafletLoadingPromise = null;

  // --- drop-in replacement ---
  function ensureLeafletLoaded() {
    // Hvis riktig Leaflet allerede er tilgjengelig: ta kontroll
    if (window.L && typeof window.L.map === 'function') {
      __LeafletNS = window.L;
      return Promise.resolve();
    }

    // Hvis L finnes, men ikke er Leaflet, prøv noConflict etter last
    const needsScript = !document.querySelector('script[src*="unpkg.com/leaflet@1.9.4/dist/leaflet.js"]');
    if (!needsScript && window.L && typeof window.L.noConflict === 'function') {
      __LeafletNS = window.L.noConflict(); // hent ekte Leaflet uten å bruke global L
      return Promise.resolve();
    }

    // Last Leaflet fra CDN
    if (leafletLoadingPromise) return leafletLoadingPromise;

    leafletLoadingPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
      s.crossOrigin = '';
      s.async = true;
      s.onload = () => {
        // Etter last: sikr riktig namespace.
        if (window.L && typeof window.L.map === 'function') {
          __LeafletNS = window.L;
        } else if (window.L && typeof window.L.noConflict === 'function') {
          __LeafletNS = window.L.noConflict();
        }
        if (!__LeafletNS || typeof __LeafletNS.map !== 'function') {
          console.error('[SSO][map] Leaflet lastet, men fant ikke gyldig L.map(). Sjekk konflikt.');
          reject(new Error('Leaflet namespace konflikt'));
          return;
        }
        resolve();
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return leafletLoadingPromise;
  }
  // --- end replacement ---

  // Init kart (kan kalles flere ganger trygt)
  async function init(containerId = 'map') {
    await ensureLeafletLoaded();
    containerIdMemo = containerId;

    const el = document.getElementById(containerId);
    if (!el) throw new Error(`[SSO][map] Fant ikke container #${containerId}`);

    const wasHidden = el.offsetParent === null || el.clientHeight === 0;

    if (!map) {
      map = __LeafletNS.map(el, {
        zoomControl: true,
        attributionControl: true,
        preferCanvas: false,
        // Leaflet har innebygget tastatur-navigasjon for kontroller
      });

      // Standard utsnitt: Oslo (kan endres)
      map.setView([59.9139, 10.7522], 12);

      tiles = __LeafletNS.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: ATTRIB
      }).addTo(map);

      markersLayer = __LeafletNS.layerGroup().addTo(map);

      // Lukker popup på ESC for tilgjengelighet
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') map.closePopup();
      }, { passive: true });
    }

    // Hvis seksjonen nettopp ble vist: invalider størrelse
    if (wasHidden) {
      setTimeout(() => map.invalidateSize(), 50);
    }

    return api;
  }

  // Legg/oppdater brukerposisjon
  function setUserLocation(lat, lng) {
    if (!map) return;
    const ll = [lat, lng];
    if (!userMarker) {
      userMarker = __LeafletNS.circleMarker(ll, {
        radius: 8,
        weight: 2,
        color: '#6d28d9',     // outline
        fillColor: '#6d28d9', // fyll
        fillOpacity: 0.3
      }).addTo(map);
      userMarker.bindPopup('Min posisjon');
    } else {
      userMarker.setLatLng(ll);
    }
    map.setView(ll, Math.max(map.getZoom(), 13));
    return ll;
  }

  // Be om posisjon på trygg måte (kun ved brukerhandling)
function locateUser() {
  if (!('geolocation' in navigator)) {
    announce('Posisjon støttes ikke i denne nettleseren.');
    return;
  }

  // valgfritt: hint om �Sdenied⬝
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' })
      .then(res => { if (res.state === 'denied') announce('Posisjon er avslått i nettleseren.'); })
      .catch(() => {});
  }

  // Vis at vi jobber
  announce('Henter posisjon ⬦');

  // 1) Prøv "fersk og presis" posisjon
  const options = {
    enableHighAccuracy: true,  // be om GPS/Wi-Fi-triangulering der det finnes
    maximumAge: 0,             // ingen cache � tving fersk måling
    timeout: 15000
  };

  const drawAccuracy = (lat, lng, accuracy) => {
    setUserLocation(lat, lng);
    // Tegn en svak sirkel som viser nøyaktighet (radius i meter)
    if (__LeafletNS && typeof __LeafletNS.circle === 'function') {
      const circle = __LeafletNS.circle([lat, lng], {
        radius: Math.max(accuracy || 0, 0),
        weight: 1,
        color: '#6d28d9',
        fillColor: '#6d28d9',
        fillOpacity: 0.1
      }).addTo(markersLayer);
      setTimeout(() => markersLayer.removeLayer(circle), 15000); // rydd etter 15s
    }
    announce(`Posisjon oppdatert (±${Math.round(accuracy||0)} m).`);
  };

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      drawAccuracy(latitude, longitude, accuracy);

      // 2) Hvis første treff er upresis (>2000 m), lytt kort etter en bedre
      if (accuracy && accuracy > 2000) {
        const watchId = navigator.geolocation.watchPosition(
          (p2) => {
            if (p2.coords.accuracy && p2.coords.accuracy < accuracy) {
              drawAccuracy(p2.coords.latitude, p2.coords.longitude, p2.coords.accuracy);
              navigator.geolocation.clearWatch(watchId);
            }
          },
          (err2) => {
            console.warn('[SSO][map] watchPosition error:', err2);
            navigator.geolocation.clearWatch(watchId);
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
        );
        // sikkerhetsstopp etter 20s uansett
        setTimeout(() => navigator.geolocation.clearWatch(watchId), 20000);
      }
    },
    (err) => {
      console.warn('[SSO][map] geolocation error:', err);
      announce('Kunne ikke hente presis posisjon (avslått eller utilgjengelig).');
    },
    options
  );
}


  // Ta imot kandidater fra multistore
  function feed(stores) {
    // Forventet felter: id, name, group, lat, lng, isPhysical, isOnline
    // (tolererer ulike nokkelnavn nedenfor)
    if (!Array.isArray(stores)) return;

    stores.forEach((s) => {
      const id = s.id || s.storeId || s.slug || `${s.group || 'store'}:${s.name || 'noname'}`;
      const name = s.name || s.displayName || id;
      const group = s.group || s.chain || s.storeGroup || 'ukjent';
      const latRaw = s.lat ?? s.latitude ?? (s.location && s.location.lat);
      const lngRaw = s.lng ?? s.longitude ?? (s.location && s.location.lng);
      const lat = Number.parseFloat(latRaw);
      const lng = Number.parseFloat(lngRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const isPhysical = !!(s.isPhysical ?? s.physical ?? s.storeType === 'physical');
      const isOnline = !!(s.isOnline ?? s.online ?? s.storeType === 'online');
      const priceRank = (typeof s.priceRank === 'number' && s.priceRank >= 1) ? Math.min(3, Math.floor(s.priceRank)) : null;

      storesIndex.set(id, { id, name, group, lat, lng, isPhysical, isOnline, priceRank });
    });

    renderStores(); // tegner markorer pa nytt
  }
  // Tegn/oppdater butikkmarkører
  function renderStores(filter = {}) {
    if (!map || !markersLayer) return;
    markersLayer.clearLayers();

    for (const s of storesIndex.values()) {
      if (filter.scope === 'physical' && !s.isPhysical) continue;
      if (filter.scope === 'online' && !s.isOnline) continue;

      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue; // ingen koordinater -> hopp over

      const style = markerStyleForPriceRank(s.priceRank);
      const marker = __LeafletNS.circleMarker([s.lat, s.lng], {
        radius: 8,
        weight: 2.5,
        color: style.stroke,
        fillColor: style.fill,
        fillOpacity: style.opacity
      }).addTo(markersLayer);

      marker.bindPopup(`<strong>${escapeHtml(s.name)}</strong><br/>Kjede: ${escapeHtml(s.group)}`);

      // lagre referanse for focus()
      s.marker = marker;
    }
  }

  // Zoom til oppgitte id-er eller grupper
  function focus({ ids = null, groups = null } = {}) {
    if (!map) return;

    const targets = [];
    for (const s of storesIndex.values()) {
      const idHit = Array.isArray(ids) && ids.includes(s.id);
      const groupHit = Array.isArray(groups) && groups.includes(s.group);
      if ((ids && idHit) || (groups && groupHit) || (!ids && !groups)) {
        if (s.marker) targets.push(s.marker.getLatLng());
      }
    }

    if (targets.length === 1) {
      map.setView(targets[0], Math.max(14, map.getZoom()));
      // åpne popup for enkel tilbakemelding
      for (const s of storesIndex.values()) {
        if (s.marker && s.marker.getLatLng().equals(targets[0])) {
          s.marker.openPopup();
          announce(`Fokuserer: ${s.name}`);
          break;
        }
      }
    } else if (targets.length > 1) {
      const bounds = __LeafletNS.latLngBounds(targets);
      map.fitBounds(bounds, { padding: [24, 24] });
      announce(`Fokuserer på ${targets.length} butikker.`);
    } else {
      announce('Fant ingen matchende butikker med posisjon.');
    }
  }

  // Tilpass til alle gjeldende markører
  function fitToStores() {
    if (!map || !markersLayer) return;
    const latlngs = [];
    markersLayer.eachLayer((layer) => {
      if (layer.getLatLng) latlngs.push(layer.getLatLng());
    });
    if (latlngs.length) {
      const bounds = __LeafletNS.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [24, 24] });
      announce(`Tilpasset utsnitt til ${latlngs.length} butikker.`);
    } else {
      announce('Ingen butikker å tilpasse til.');
    }
  }

  // Hjelp: SR status
  function announce(msg) {
    const box = document.getElementById('map-status');
    if (box) box.textContent = msg;
  }

  // Hjelp: escape for popup
  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  const api = {
    init,
    feed,
    focus,
    fitToStores,
    setUserLocation,
    locateUser
  };

  window.SSO_MAP = api;
})();


