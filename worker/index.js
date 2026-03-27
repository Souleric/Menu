const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function hmacSign(secret, method, path, body, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const message = `${timestamp}\r\n${method.toUpperCase()}\r\n${path}\r\n\r\n${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Google Places Autocomplete ──────────────────────────────────────────────
async function handleAutocomplete(body, env) {
  const { query } = body;
  if (!query || query.trim().length < 2) return json({ suggestions: [] });

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', query.trim());
  url.searchParams.set('components', 'country:my');
  url.searchParams.set('language', 'en');
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);

  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    return json({ error: `Places API: ${data.status}` }, 400);
  }

  const suggestions = (data.predictions || []).slice(0, 5).map(p => ({
    placeId: p.place_id,
    description: p.description,
  }));
  return json({ suggestions });
}

// ── Google Place Details (coordinates) ─────────────────────────────────────
async function handlePlaceDetails(body, env) {
  const { placeId } = body;
  if (!placeId) return json({ error: 'placeId required' }, 400);

  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'formatted_address,geometry');
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);

  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.status !== 'OK') return json({ error: `Place Details: ${data.status}` }, 400);

  const loc = data.result.geometry.location;
  return json({
    address: data.result.formatted_address,
    lat: loc.lat.toFixed(6),
    lng: loc.lng.toFixed(6),
  });
}

// ── Lalamove Delivery Quote ─────────────────────────────────────────────────
async function handleQuote(body, env) {
  const { address, lat, lng } = body;
  if (!address || !lat || !lng) return json({ error: 'address, lat and lng are required' }, 400);

  const dropLat = parseFloat(lat).toFixed(6);
  const dropLng = parseFloat(lng).toFixed(6);
  const path = '/v3/quotations';
  const timestamp = Date.now().toString();
  const scheduleAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const bodyObj = {
    serviceType: 'MOTORCYCLE',
    language: 'en_MY',
    scheduleAt,
    stops: [
      { coordinates: { lat: env.STORE_LAT, lng: env.STORE_LNG }, address: env.STORE_ADDRESS },
      { coordinates: { lat: dropLat, lng: dropLng }, address },
    ],
  };
  const bodyStr = JSON.stringify(bodyObj);
  const signature = await hmacSign(env.LALAMOVE_API_SECRET, 'POST', path, bodyStr, timestamp);

  const llRes = await fetch(`${env.LALAMOVE_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `hmac ${env.LALAMOVE_API_KEY}:${timestamp}:${signature}`,
      'Market': env.MARKET,
      'Request-ID': crypto.randomUUID(),
    },
    body: bodyStr,
  });
  const llData = await llRes.json();
  if (!llRes.ok) throw new Error(llData?.message || llData?.details?.[0]?.message || JSON.stringify(llData));

  const totalCents = parseInt(llData.priceBreakdown?.total || 0);
  const price = totalCents / 100;
  const distanceM = parseInt(llData.distance?.value || 0);
  const etaMin = Math.ceil(distanceM / 500) + 10;
  const distanceKm = (distanceM / 1000).toFixed(1);

  return json({
    price,
    priceFormatted: `RM ${price.toFixed(2)}`,
    eta: `${etaMin}–${etaMin + 15} min`,
    distanceKm,
    currency: 'MYR',
    serviceType: 'Motorcycle',
  });
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
      const body = await request.json();
      const type = body.type;
      if (type === 'autocomplete')   return await handleAutocomplete(body, env);
      if (type === 'place-details')  return await handlePlaceDetails(body, env);
      if (type === 'quote')          return await handleQuote(body, env);
      return json({ error: 'Unknown request type' }, 400);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }
};
