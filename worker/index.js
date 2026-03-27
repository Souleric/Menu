const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function hmacSign(secret, method, path, body, timestamp) {
  const message = `${timestamp}\r\n${method.toUpperCase()}\r\n${path}\r\n\r\n${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=my`;
  const res = await fetch(url, { headers: { 'User-Agent': '9PalaceCoffeeMenu/1.0' } });
  const data = await res.json();
  if (!data.length) throw new Error('Address not found. Please enter a more specific address.');
  return { lat: String(data[0].lat), lng: String(data[0].lon) };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    try {
      const { address, lat, lng } = await request.json();
      if (!address || address.trim().length < 5) {
        throw new Error('Please enter a valid delivery address.');
      }

      // Use provided coordinates (from Google Places) or fall back to geocoding
      let dropLat, dropLng;
      if (lat && lng) {
        dropLat = parseFloat(lat).toFixed(6);
        dropLng = parseFloat(lng).toFixed(6);
      } else {
        const coords = await geocode(address.trim());
        dropLat = parseFloat(coords.lat).toFixed(6);
        dropLng = parseFloat(coords.lng).toFixed(6);
      }

      const path = '/v3/quotations';
      const timestamp = Date.now().toString();
      // scheduleAt must be a future RFC3339 time (5 min from now)
      const scheduleAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

      const bodyObj = {
        serviceType: 'MOTORCYCLE',
        language: 'en_MY',
        scheduleAt,
        stops: [
          {
            coordinates: { lat: env.STORE_LAT, lng: env.STORE_LNG },
            address: env.STORE_ADDRESS,
          },
          {
            coordinates: { lat: dropLat, lng: dropLng },
            address: address.trim(),
          },
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

      if (!llRes.ok) {
        // Return full error detail for easier debugging
        const errMsg = llData?.message || llData?.details?.[0]?.message || JSON.stringify(llData);
        throw new Error(errMsg);
      }

      // Price is in cents (e.g. 900 = RM 9.00)
      const totalCents = parseInt(llData.priceBreakdown?.total || 0);
      const price = totalCents / 100;
      const priceFormatted = `RM ${price.toFixed(2)}`;

      // ETA estimate based on distance (motorcycle ~30 km/h + 10 min handling)
      const distanceM = parseInt(llData.distance?.value || 0);
      const travelMin = Math.ceil(distanceM / 500); // 500 m/min = 30 km/h
      const etaMin = travelMin + 10;
      const etaMax = etaMin + 15;
      const eta = `${etaMin}–${etaMax} min`;
      const distanceKm = (distanceM / 1000).toFixed(1);

      return new Response(JSON.stringify({
        price,
        priceFormatted,
        eta,
        distanceKm,
        currency: 'MYR',
        serviceType: 'Motorcycle',
      }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }
};
