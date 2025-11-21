// Enkel diagnostikk: bekreft at Kassalapp-nøkkelen finnes (uten å lekke den)
export async function handler() {
  const names = [
    'KASSALAPP_TOKEN',
    'KASSALAPP_KEY',
    'KASsALAPP_KEY',
    'KASSALAPP_API_KEY'
  ];
  const found = [];
  for (const n of names) {
    if (process.env[n] && String(process.env[n]).trim()) {
      found.push({ name: n, length: String(process.env[n]).length });
    }
  }
  // Case-insensitivt søk (i tilfelle skrivefeil)
  const lowerEnv = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lowerEnv[n.toLowerCase()];
    if (v && String(v).trim() && !found.find(f => f.name.toLowerCase() === n.toLowerCase())) {
      found.push({ name: n + ' (case-insensitive)', length: String(v).length });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      hasAny: found.length > 0,
      candidatesFound: found
    }),
    headers: { 'Content-Type': 'application/json' }
  };
}
// Viser om Kassalapp-nøkkel finnes i env (uten å lekke innhold)
export async function handler() {
  const names = ['KASSALAPP_TOKEN','KASSALAPP_KEY','KASsALAPP_KEY','KASSALAPP_API_KEY'];
  const found = [];
  for (const n of names) if (process.env[n]?.trim()) found.push({ name: n, length: String(process.env[n]).length });
  return { statusCode: 200, body: JSON.stringify({ hasAny: found.length > 0, candidatesFound: found }), headers: { 'Content-Type': 'application/json' } };
}
