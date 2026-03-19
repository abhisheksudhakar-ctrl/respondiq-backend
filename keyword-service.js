// ══════════════════════════════════════════════════════════════
// keyword-service.js
// Google Ads API - Keyword Planner Integration for RespondIQ
// Uses REST API directly (no npm package dependency issues)
// ══════════════════════════════════════════════════════════════

const API_VERSION = 'v23';

// ── Simple in-memory cache (keyword results don't change within a day) ──
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Currency cache (account currency never changes) ──
let accountCurrencyCache = null;

// ── Approximate USD exchange rates for common currencies ──
// Used to convert non-USD bid estimates to USD for display
const USD_EXCHANGE_RATES = {
  'USD': 1,
  'INR': 85,    // 1 USD ≈ 85 INR
  'EUR': 0.92,  // 1 USD ≈ 0.92 EUR
  'GBP': 0.79,  // 1 USD ≈ 0.79 GBP
  'CAD': 1.36,  // 1 USD ≈ 1.36 CAD
  'AUD': 1.54,  // 1 USD ≈ 1.54 AUD
  'JPY': 149,   // 1 USD ≈ 149 JPY
  'BRL': 5.00,  // 1 USD ≈ 5.00 BRL
  'AED': 3.67,  // 1 USD ≈ 3.67 AED
  'SGD': 1.34,  // 1 USD ≈ 1.34 SGD
  'MXN': 17.20, // 1 USD ≈ 17.20 MXN
};

function getCacheKey(seedKeywords, pageUrl, locationId, languageId) {
  return JSON.stringify({ seedKeywords, pageUrl, locationId, languageId });
}

// ── Check if all required env vars are set ──
function isKeywordServiceConfigured() {
  return !!(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID &&
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
  );
}

// ── Get a fresh access token using the refresh token ──
async function getAccessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('OAuth token refresh failed: ' + errText);
  }

  const data = await response.json();
  return data.access_token;
}

// ── Detect the Google Ads account currency via GAQL ──
async function getAccountCurrency() {
  if (accountCurrencyCache) return accountCurrencyCache;

  try {
    const accessToken = await getAccessToken();
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
    const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');

    const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': loginCustomerId,
      },
      body: JSON.stringify({ query: 'SELECT customer.currency_code FROM customer LIMIT 1' }),
    });

    if (response.ok) {
      const data = await response.json();
      // searchStream returns an array of result batches
      const currency = data?.[0]?.results?.[0]?.customer?.currencyCode || 'USD';
      accountCurrencyCache = currency;
      console.log('[RespondIQ] Account currency detected:', currency);
      return currency;
    } else {
      const errText = await response.text();
      console.warn('[RespondIQ] Currency detection failed:', response.status, errText.substring(0, 200));
      // Fallback: use env var or default to USD
      return process.env.GOOGLE_ADS_CURRENCY || 'USD';
    }
  } catch (err) {
    console.warn('[RespondIQ] Currency detection error:', err.message);
    return process.env.GOOGLE_ADS_CURRENCY || 'USD';
  }
}

// ── Geo-target constant mapping (location name -> criterion ID) ──
const GEO_TARGET_MAP = {
  'global / worldwide': '2840',
  'united states': '2840',
  'canada': '2124',
  'mexico': '2162',
  'united kingdom': '2826',
  'germany': '2276',
  'france': '2250',
  'spain': '2724',
  'italy': '2380',
  'netherlands': '2528',
  'switzerland': '2756',
  'sweden': '2752',
  'norway': '2578',
  'denmark': '2208',
  'finland': '2246',
  'belgium': '2056',
  'austria': '2040',
  'ireland': '2372',
  'poland': '2616',
  'portugal': '2620',
  'australia': '2036',
  'japan': '2392',
  'south korea': '2410',
  'singapore': '2702',
  'india': '2356',
  'china': '2156',
  'brazil': '2076',
  'united arab emirates': '2784',
  'saudi arabia': '2682',
  'israel': '2376',
  'south africa': '2710',
  'new zealand': '2554',
  'california': '21137',
  'texas': '21176',
  'florida': '21129',
  'new york': '21167',
  'illinois': '21135',
  'pennsylvania': '21171',
  'new york dma': '200501',
  'los angeles dma': '200803',
  'chicago dma': '200602',
  'dallas-ft. worth dma': '200623',
  'houston dma': '200618',
  'washington dc dma': '200511',
  'atlanta dma': '200524',
  'boston dma': '200506',
  'san francisco dma': '200807',
  'phoenix dma': '200753',
  'seattle-tacoma dma': '200819',
  'london': '1006886',
};

function resolveGeoTarget(locationStr) {
  if (!locationStr) return '2840';
  const normalized = locationStr.toLowerCase().trim();
  if (GEO_TARGET_MAP[normalized]) return GEO_TARGET_MAP[normalized];
  for (const [key, val] of Object.entries(GEO_TARGET_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return val;
  }
  return '2840';
}

async function getKeywordIdeas(seedKeywords, pageUrl, locationStr, languageId) {
  const cacheKey = getCacheKey(seedKeywords, pageUrl, locationStr, languageId);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[RespondIQ] Keyword cache hit');
    return cached.data;
  }

  const accessToken = await getAccessToken();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  const geoTargetId = resolveGeoTarget(locationStr);

  const requestBody = {
    language: `languageConstants/${languageId || '1000'}`,
    geoTargetConstants: [`geoTargetConstants/${geoTargetId}`],
    includeAdultKeywords: false,
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    pageSize: 30,
  };

  if (seedKeywords && seedKeywords.length > 0 && pageUrl) {
    requestBody.keywordAndUrlSeed = { keywords: seedKeywords.slice(0, 10), url: pageUrl };
  } else if (seedKeywords && seedKeywords.length > 0) {
    requestBody.keywordSeed = { keywords: seedKeywords.slice(0, 10) };
  } else if (pageUrl) {
    requestBody.urlSeed = { url: pageUrl };
  }

  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}:generateKeywordIdeas`;
  console.log('[RespondIQ] Calling Keyword Planner REST API | geo:', geoTargetId, '| seeds:', seedKeywords?.join(', ') || 'none');
  console.log('[RespondIQ] KW API URL:', url);
  console.log('[RespondIQ] KW login-customer-id:', loginCustomerId, '| customer_id:', customerId);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': loginCustomerId,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error('[RespondIQ] Keyword Planner API FULL error:', response.status, errBody);
    throw new Error(`Keyword Planner API ${response.status}: ${errBody.substring(0, 500)}`);
  }

  const data = await response.json();
  const results = data.results || [];

  // ── Detect account currency and determine conversion factor ──
  const currency = await getAccountCurrency();
  const exchangeRate = USD_EXCHANGE_RATES[currency] || 1;
  const needsConversion = currency !== 'USD' && exchangeRate > 1;
  if (needsConversion) {
    console.log('[RespondIQ] CPC currency conversion: ' + currency + ' -> USD (rate: 1 USD = ' + exchangeRate + ' ' + currency + ')');
  } else {
    console.log('[RespondIQ] Account currency: ' + currency + ' (no conversion needed)');
  }

  // ── Log first raw result for diagnostics ──
  if (results.length > 0) {
    const s = results[0];
    console.log('[RespondIQ] KW sample:', s.text,
      '| lowMicros:', s.keywordIdeaMetrics?.lowTopOfPageBidMicros,
      '| highMicros:', s.keywordIdeaMetrics?.highTopOfPageBidMicros,
      '| currency:', currency);
  }
  console.log('[RespondIQ] KW API returned', results.length, 'raw results');

  const ideas = results.map(result => {
    const lowMicros = result.keywordIdeaMetrics?.lowTopOfPageBidMicros
      ? parseInt(result.keywordIdeaMetrics.lowTopOfPageBidMicros, 10) : 0;
    const highMicros = result.keywordIdeaMetrics?.highTopOfPageBidMicros
      ? parseInt(result.keywordIdeaMetrics.highTopOfPageBidMicros, 10) : 0;

    // Convert micros to account currency, then to USD if needed
    let lowDollars = lowMicros / 1_000_000;
    let highDollars = highMicros / 1_000_000;
    if (needsConversion) {
      lowDollars = lowDollars / exchangeRate;
      highDollars = highDollars / exchangeRate;
    }

    return {
      keyword: result.text || '',
      avg_monthly_searches: result.keywordIdeaMetrics?.avgMonthlySearches
        ? parseInt(result.keywordIdeaMetrics.avgMonthlySearches, 10) : 0,
      competition: result.keywordIdeaMetrics?.competition || 'UNSPECIFIED',
      competition_index: result.keywordIdeaMetrics?.competitionIndex || 0,
      low_top_of_page_bid_micros: lowMicros,
      high_top_of_page_bid_micros: highMicros,
      low_cpc: '$' + lowDollars.toFixed(2),
      high_cpc: '$' + highDollars.toFixed(2),
    };
  })
    .filter(kw => kw.avg_monthly_searches > 0)
    .sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches)
    .slice(0, 30);

  cache.set(cacheKey, { data: ideas, timestamp: Date.now() });
  console.log('[RespondIQ] Keyword Planner returned', ideas.length, 'ideas');
  return ideas;
}

module.exports = { getKeywordIdeas, isKeywordServiceConfigured, resolveGeoTarget };
