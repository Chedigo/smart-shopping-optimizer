// Netlify Function: OpenRouteService Matrix proxy (one-to-many)
// POST /.netlify/functions/ors-matrix
// Body: { origin: {lat,lng}, destinations: [{lat,lng}, ...], profile: "driving-car" }
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Use POST" });
    }
    const KEY = process.env.ORS_KEY;
    if (!KEY) return json(500, { error: "Missing ORS_KEY env" });

    const { origin, destinations, profile } = JSON.parse(event.body || "{}");

    if (!origin || !Array.isArray(destinations) || destinations.length === 0) {
      return json(400, { error: "origin and destinations[] required" });
    }

    const prof = (profile || "driving-car").trim();
    const locations = [
      [origin.lng, origin.lat],
      ...destinations.map(d => [d.lng, d.lat])
    ];
    const sources = [0];
    const destinationsIdx = [];
    for (let i = 1; i < locations.length; i++) destinationsIdx.push(i);

    const body = {
      locations,
      metrics: ["distance", "duration"],
      units: "m", // ORS returnerer meter/sekunder
      sources,
      destinations: destinationsIdx
    };

    const resp = await fetch(`https://api.openrouteservice.org/v2/matrix/${encodeURIComponent(prof)}`, {
      method: "POST",
      headers: {
        "Authorization": KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json(resp.status, { error: "Upstream ORS error", details: data });
    }

    // dist/dur arrays er [sources x destinations]. Vi har 1 source (index 0).
    const distances = data.distances?.[0] ?? [];
    const durations = data.durations?.[0] ?? [];

    return json(200, {
      ok: true,
      distances_m: distances,
      durations_s: durations
    });
  } catch (err) {
    return json(500, { error: "Unexpected", details: String(err) });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}
