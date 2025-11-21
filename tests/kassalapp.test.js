const test = require('node:test');
const assert = require('node:assert/strict');

const { handler, __test } = require('../netlify/functions/kassalapp.js');

function stubFetchWithProducts(products, options = {}) {
  const { shape = 'ean', onRequest } = options;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (typeof onRequest === 'function') onRequest(url);
    let payload;
    if (shape === 'search') {
      const list = Array.isArray(products) ? products : [products];
      payload = { data: list };
    } else if (shape === 'raw') {
      payload = products;
    } else {
      const list = Array.isArray(products) ? products : [products];
      payload = { data: { products: list } };
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      headers: { get: () => 'application/json' }
    };
  };
  return () => { global.fetch = originalFetch; };
}

function withEnv(key, value) {
  const prev = Object.prototype.hasOwnProperty.call(process.env, key)
    ? process.env[key]
    : undefined;
  process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

test('handler surfaces upstream unit price metadata', async (t) => {
  const restoreFetch = stubFetchWithProducts([
    {
      id: 'p1',
      name: 'Kaffe 500g',
      ean: '1234567890123',
      size: '500 g',
      current_price: {
        price: 24.0,
        unit_price: 80.0,
        unit_price_unit: 'kg',
        unit_price_qty: 1
      },
      store: { name: 'KIWI Årvoll', group: 'KIWI' }
    }
  ]);
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({ queryStringParameters: { ean: '1234567890123' } });
  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);

  const item = body.items[0];
  assert.equal(item.price, 24);
  assert.equal(item.unitPricing.source, 'current_price');
  assert.equal(item.unitPricing.pricePerKg, 80);
  assert.equal(item.pricePerKg, 80);
  assert.equal(item.packageInfo.kilograms, 0.5);
});

test('handler falls back to package size for unit pricing', async (t) => {
  const restoreFetch = stubFetchWithProducts([
    {
      id: 'p2',
      name: 'Appelsinjuice 0.75l',
      ean: '9876543210987',
      size: '750 ml',
      current_price: {
        price: 30.0
      },
      store: { name: 'MENY Bislett', group: 'MENY_NO' }
    }
  ]);
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({ queryStringParameters: { ean: '9876543210987' } });
  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body);
  const item = body.items[0];

  assert.equal(item.unitPricing.source, 'current_price');
  assert.equal(item.packageInfo.liters, 0.75);
  assert.equal(item.pricePerLiter, 40);
  assert.equal(item.unitPricing.pricePerLiter, null);
  assert.equal(item.pricePerKg, null);
});

test('parseSizeString understands X notation', () => {
  const { parseSizeString } = __test;
  const parsed = parseSizeString('3x200 g');
  assert.equal(parsed.quantity, 600);
  assert.equal(parsed.unit, 'g');
  assert.equal(parsed.unitRaw.toLowerCase(), 'g');
});

test('handler builds fallback query from category/brand filters', async (t) => {
  let requestedUrl = '';
  const restoreFetch = stubFetchWithProducts(
    [
      {
        id: 'p3',
        name: 'Tine Lettmelk 1L',
        ean: '3333333333333',
        category: 'Meieri',
        brand: 'Tine',
        size: '1 l',
        current_price: { price: 20 }
      }
    ],
    {
      shape: 'search',
      onRequest: (url) => { requestedUrl = String(url); }
    }
  );
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({ queryStringParameters: { category: 'Meieri', brand: 'Tine' } });
  assert.equal(response.statusCode, 200);
  assert.ok(requestedUrl.includes('search=Meieri+Tine'));

  const body = JSON.parse(response.body);
  assert.equal(body.count, 1);
  assert.equal(body.appliedFilters.category, 'Meieri');
  assert.equal(body.appliedFilters.brand, 'Tine');
  assert.equal(body.items[0].brand, 'Tine');
});

test('handler applies brand filter on search results', async (t) => {
  const restoreFetch = stubFetchWithProducts(
    [
      {
        id: 'p4',
        name: 'Tine Helmelk 1L',
        ean: '4444444444444',
        category: 'Meieri',
        brand: 'Tine',
        size: '1 l',
        current_price: { price: 22 }
      },
      {
        id: 'p5',
        name: 'Q Helmelk 1L',
        ean: '5555555555555',
        category: 'Meieri',
        brand: 'Q',
        size: '1 l',
        current_price: { price: 21 }
      }
    ],
    { shape: 'search' }
  );
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({ queryStringParameters: { q: 'melk', brand: 'Tine' } });
  const body = JSON.parse(response.body);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].brand, 'Tine');
});

test('handler respects lactoseFree filter via tags', async (t) => {
  const restoreFetch = stubFetchWithProducts(
    [
      {
        id: 'p6',
        name: 'Tine Lettmelk Laktosefri',
        ean: '6666666666666',
        category: 'Meieri',
        brand: 'Tine',
        size: '1 l',
        tags: ['Laktosefri'],
        current_price: { price: 25 }
      },
      {
        id: 'p7',
        name: 'Tine Lettmelk',
        ean: '7777777777777',
        category: 'Meieri',
        brand: 'Tine',
        size: '1 l',
        current_price: { price: 23 }
      }
    ],
    { shape: 'search' }
  );
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({ queryStringParameters: { q: 'lettmelk', lactoseFree: 'true' } });
  const body = JSON.parse(response.body);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].ean, '6666666666666');
});

test('handler filters by size using weight mode', async (t) => {
  const restoreFetch = stubFetchWithProducts(
    [
      {
        id: 'p8',
        name: 'Kyllingfilet 700g',
        ean: '8888888888888',
        category: 'Kjøtt',
        brand: 'Prior',
        size: '700 g',
        current_price: { price: 79.9 }
      },
      {
        id: 'p9',
        name: 'Kyllingfilet 1kg',
        ean: '9999999999999',
        category: 'Kjøtt',
        brand: 'Prior',
        size: '1 kg',
        current_price: { price: 119.9 }
      }
    ],
    { shape: 'search' }
  );
  const restoreEnv = withEnv('KASSALAPP_KEY', 'test-key');

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const response = await handler({
    queryStringParameters: {
      q: 'kyllingfilet',
      unitMin: '0.9',
      unitType: 'mass'
    }
  });
  const body = JSON.parse(response.body);
  assert.equal(body.count, 1);
  assert.equal(body.items[0].ean, '9999999999999');
});
