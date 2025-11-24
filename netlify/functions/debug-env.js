// netlify/functions/debug-env.js
// Enkel diagnostikk: viser om Kassalapp-nøkkel finnes i env (uten å lekke den)

function findKassalappKeys() {
  const candidateNames = [
    'KASSALAPP_TOKEN',
    'KASSALAPP_KEY',
    'KASsALAPP_KEY',
    'KASSALAPP_API_KEY'
  ];

  const found = [];

  // 1) Direkte treff på kandidat-navn
  for (const name of candidateNames) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      found.push({
        name,
        length: value.length
      });
    }
  }

  // 2) Case-insensitivt søk etter nøkler som inneholder "kassalapp"
  const lowerEnv = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v])
  );

  for (const [key, value] of Object.entries(lowerEnv)) {
    if (!key.includes('kassalapp')) continue;
    if (typeof value !== 'string' || !value.trim()) continue;

    const already = found.some(f => f.name.toLowerCase() === key);
    if (!already) {
      found.push({
        name: key,
        length: value.length
      });
    }
  }

  return {
    hasAny: found.length > 0,
    candidatesFound: found
  };
}

async function handler(event, context) {
  const info = findKassalappKeys();

  return {
    statusCode: 200,
    body: JSON.stringify(info),
    headers: {
      'Content-Type': 'application/json'
    }
  };
}

exports.handler = handler;
