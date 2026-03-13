// ══════════════════════════════════════════════════════════════
// keyword-service.js
// Google Ads API - Keyword Planner Integration for RespondIQ
// Fetches real search volume, competition, and CPC bid data
// ══════════════════════════════════════════════════════════════

const { GoogleAdsApi } = require('google-ads-api');

// ── Simple in-memory cache (keyword results don't change within a day) ──
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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

// ── Initialize Google Ads API client ──
function getGoogleAdsClient() {
  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  return client.Customer({
    customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });
}

// ── Geo-target constant mapping (location name -> criterion ID) ──
const GEO_TARGET_MAP = {
  // Countries
  'global / worldwide': '2840',  // Default to US for global
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
  // US States (top ones)
  'california': '21137',
  'texas': '21176',
  'florida': '21129',
  'new york': '21167',
  'illinois': '21135',
  'pennsylvania': '21171',
  // US DMAs
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
  // UK Regions
  'london': '1006886',
};

/**
 * Resolve a location string from the form to a geo-target constant ID.
 * Falls back to US (2840) if no match found.
 */
function resolveGeoTarget(locationStr) {
  if (!locationStr) return '2840';
  const normalized = locationStr.toLowerCase().trim();

  // Direct match
  if (GEO_TARGET_MAP[normalized]) return GEO_TARGET_MAP[normalized];

  // Partial match (e.g., "US - Northeast" -> try "united states")
  for (const [key, val] of Object.entries(GEO_TARGET_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return val;
    }
  }

  // Default to US
  return '2840';
}

/**
 * Fetch keyword ideas from Google Keyword Planner.
 *
 * @param {string[]} seedKeywords - Seed keywords to generate ideas from
 * @param {string|null} pageUrl - Optional URL to seed ideas from
 * @param {string} locationStr - Location string from the form (e.g., "United States", "New York DMA")
 * @param {string} languageId - Language criterion ID (default: 1000 = English)
 * @returns {Array} Array of keyword idea objects
 */
async function getKeywordIdeas(seedKeywords, pageUrl, locationStr, languageId) {
  // Check cache first
  const cacheKey = getCacheKey(seedKeywords, pageUrl, locationStr, languageId);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[RespondIQ] Keyword cache hit');
    return cached.data;
  }

  const customer = getGoogleAdsClient();

  const geoTargetId = resolveGeoTarget(locationStr);
  const geoTarget = `geoTargetConstants/${geoTargetId}`;
  const language = `languageConstants/${languageId || '1000'}`;

  const requestBody = {
    keyword_plan_network: 'GOOGLE_SEARCH',
    geo_target_constants: [geoTarget],
    language: language,
    include_adult_keywords: false,
  };

  // Seed with keywords, URL, or both
  if (seedKeywords && seedKeywords.length > 0 && pageUrl) {
    requestBody.keyword_and_url_seed = {
      keywords: seedKeywords.slice(0, 10), // API limit
      url: pageUrl,
    };
  } else if (seedKeywords && seedKeywords.length > 0) {
    requestBody.keyword_seed = { keywords: seedKeywords.slice(0, 10) };
  } else if (pageUrl) {
    requestBody.url_seed = { url: pageUrl };
  }

  console.log('[RespondIQ] Calling Google Keyword Planner | geo:', geoTargetId, '| seeds:', seedKeywords?.join(', ') || 'none', '| url:', pageUrl || 'none');

  const results = await customer.keywordPlanIdea.generateKeywordIdeas(requestBody);

  // Transform results into clean JSON for the prompt
  const ideas = results.map(idea => ({
    keyword: idea.text || '',
    avg_monthly_searches: idea.keyword_idea_metrics?.avg_monthly_searches || 0,
    competition: idea.keyword_idea_metrics?.competition || 'UNSPECIFIED',
    competition_index: idea.keyword_idea_metrics?.competition_index || 0,
    low_top_of_page_bid_micros: idea.keyword_idea_metrics?.low_top_of_page_bid_micros || 0,
    high_top_of_page_bid_micros: idea.keyword_idea_metrics?.high_top_of_page_bid_micros || 0,
  }))
    .filter(kw => kw.avg_monthly_searches > 0) // Remove zero-volume keywords
    .sort((a, b) => b.avg_monthly_searches - a.avg_monthly_searches) // Highest volume first
    .slice(0, 30); // Top 30

  // Cache the results
  cache.set(cacheKey, { data: ideas, timestamp: Date.now() });

  console.log('[RespondIQ] Keyword Planner returned', ideas.length, 'ideas');
  return ideas;
}

module.exports = { getKeywordIdeas, isKeywordServiceConfigured, resolveGeoTarget };
