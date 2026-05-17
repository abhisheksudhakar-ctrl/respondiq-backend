// ══════════════════════════════════════════════════════════════
// competitive-intel-service.js  (v2.0 — Pure Node.js, no Python)
// Google Ads Transparency Center — FREE Competitive Intelligence
// Uses native fetch against Google's internal SearchSuggestions API
// ══════════════════════════════════════════════════════════════

// ── In-memory cache (competitor data is stable within a day) ──
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// ── Session: cookies from adstransparency.google.com ──
let sessionCookies = '';
let sessionTimestamp = 0;
const SESSION_TTL = 30 * 60 * 1000; // Refresh cookies every 30 min

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'user-agent': BROWSER_UA,
};

const COUNTRY_REGION_CODES = {
  'united states': 'US',
  'global / worldwide': 'anywhere',
  'global': 'anywhere',
  'worldwide': 'anywhere',
  'canada': 'CA',
  'mexico': 'MX',
  'united kingdom': 'GB',
  'germany': 'DE',
  'france': 'FR',
  'spain': 'ES',
  'italy': 'IT',
  'netherlands': 'NL',
  'switzerland': 'CH',
  'sweden': 'SE',
  'norway': 'NO',
  'denmark': 'DK',
  'finland': 'FI',
  'belgium': 'BE',
  'austria': 'AT',
  'ireland': 'IE',
  'poland': 'PL',
  'portugal': 'PT',
  'czech republic': 'CZ',
  'romania': 'RO',
  'greece': 'GR',
  'hungary': 'HU',
  'australia': 'AU',
  'japan': 'JP',
  'south korea': 'KR',
  'singapore': 'SG',
  'hong kong': 'HK',
  'india': 'IN',
  'china': 'CN',
  'indonesia': 'ID',
  'thailand': 'TH',
  'philippines': 'PH',
  'vietnam': 'VN',
  'malaysia': 'MY',
  'taiwan': 'TW',
  'new zealand': 'NZ',
  'bangladesh': 'BD',
  'pakistan': 'PK',
  'united arab emirates': 'AE',
  'saudi arabia': 'SA',
  'israel': 'IL',
  'qatar': 'QA',
  'bahrain': 'BH',
  'kuwait': 'KW',
  'oman': 'OM',
  'egypt': 'EG',
  'south africa': 'ZA',
  'nigeria': 'NG',
  'kenya': 'KE',
  'morocco': 'MA',
  'turkey': 'TR',
  'brazil': 'BR',
  'argentina': 'AR',
  'colombia': 'CO',
  'chile': 'CL',
  'peru': 'PE',
  'puerto rico': 'PR',
  'costa rica': 'CR',
  'panama': 'PA',
  'dominican republic': 'DO',
  'ecuador': 'EC',
};

const US_SUBREGIONS = new Set([
  'us - northeast', 'us - southeast', 'us - midwest', 'us - southwest', 'us - west coast', 'us - pacific northwest',
  'california', 'texas', 'florida', 'new york', 'illinois', 'pennsylvania', 'ohio', 'georgia', 'north carolina',
  'michigan', 'new jersey', 'virginia', 'washington', 'arizona', 'massachusetts', 'tennessee', 'indiana',
  'missouri', 'maryland', 'wisconsin', 'colorado', 'minnesota', 'south carolina', 'alabama', 'louisiana',
  'kentucky', 'oregon', 'oklahoma', 'connecticut', 'utah', 'iowa', 'nevada', 'arkansas', 'mississippi',
  'kansas', 'new mexico', 'nebraska', 'hawaii', 'idaho', 'west virginia', 'maine', 'montana', 'rhode island',
  'delaware', 'south dakota', 'north dakota', 'alaska', 'vermont', 'wyoming', 'district of columbia'
]);

const UK_SUBREGIONS = new Set([
  'london', 'england - south east', 'england - south west', 'england - midlands', 'england - north west',
  'england - north east', 'england - yorkshire', 'scotland', 'wales', 'northern ireland'
]);

function normalizeLocationList(locations) {
  if (Array.isArray(locations)) return locations.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof locations === 'string') return locations.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function resolveTransparencyRegion(location) {
  const label = String(location || '').trim() || 'United States';
  const normalized = label.toLowerCase();

  if (COUNTRY_REGION_CODES[normalized]) return { label, region: COUNTRY_REGION_CODES[normalized] };
  if (US_SUBREGIONS.has(normalized) || normalized.includes(' dma') || normalized.endsWith(' dma')) return { label, region: 'US' };
  if (UK_SUBREGIONS.has(normalized)) return { label, region: 'GB' };
  if (/^[A-Z]{2}$/.test(label)) return { label, region: label };

  return { label, region: 'anywhere' };
}

function resolveTransparencyRegions(locations) {
  const list = normalizeLocationList(locations);
  const source = list.length > 0 ? list : ['United States'];
  return source.slice(0, 3).map(resolveTransparencyRegion);
}

function buildTransparencyUrl(advertiserId, region) {
  const safeRegion = region || 'anywhere';
  return `https://adstransparency.google.com/advertiser/${advertiserId}?region=${encodeURIComponent(safeRegion)}`;
}

// ══════════════════════════════════════════════════════════════
// Session: grab cookies from the Transparency Center homepage
// ══════════════════════════════════════════════════════════════
async function ensureSession() {
  if (sessionCookies && Date.now() - sessionTimestamp < SESSION_TTL) {
    return; // Session still fresh
  }

  try {
    console.log('[RespondIQ] Transparency Center: refreshing session cookies...');
    const res = await fetch('https://adstransparency.google.com/?region=anywhere', {
      method: 'GET',
      headers: {
        ...COMMON_HEADERS,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
      redirect: 'follow',
    });

    // Extract set-cookie headers
    const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (rawCookies.length > 0) {
      sessionCookies = rawCookies.map(c => c.split(';')[0]).join('; ');
      sessionTimestamp = Date.now();
      console.log('[RespondIQ] Transparency Center: session established (' + rawCookies.length + ' cookies)');
    } else {
      // Fallback: some Node versions don't support getSetCookie()
      // Try raw header approach
      const setCookieHeader = res.headers.get('set-cookie') || '';
      if (setCookieHeader) {
        sessionCookies = setCookieHeader
          .split(/,(?=[^ ])/)
          .map(c => c.split(';')[0].trim())
          .join('; ');
        sessionTimestamp = Date.now();
        console.log('[RespondIQ] Transparency Center: session established (fallback cookie parse)');
      } else {
        // Proceed without cookies: Google may still respond
        sessionCookies = '';
        sessionTimestamp = Date.now();
        console.warn('[RespondIQ] Transparency Center: no cookies received, proceeding without session');
      }
    }
  } catch (err) {
    console.warn('[RespondIQ] Transparency Center: session init failed:', err.message);
    // Don't block: set timestamp so we don't retry immediately
    sessionCookies = '';
    sessionTimestamp = Date.now();
  }
}

// ══════════════════════════════════════════════════════════════
// Core: Query Google's SearchSuggestions API via native fetch
// ══════════════════════════════════════════════════════════════
async function fetchSuggestions(query) {
  await ensureSession();

  const reqBody = JSON.stringify({ '1': query, '2': 10, '3': 10 });

  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': BROWSER_UA,
    'origin': 'https://adstransparency.google.com',
    'referer': 'https://adstransparency.google.com/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
  if (sessionCookies) {
    headers['cookie'] = sessionCookies;
  }

  const res = await fetch(
    'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchSuggestions?authuser=0',
    {
      method: 'POST',
      headers,
      body: new URLSearchParams({ 'f.req': reqBody }),
    }
  );

  if (!res.ok) {
    throw new Error('Transparency API HTTP ' + res.status);
  }

  const data = await res.json();
  return data['1'] || [];
}

// ══════════════════════════════════════════════════════════════
// Parse raw API response into structured competitor objects
// ══════════════════════════════════════════════════════════════
function parseSuggestions(suggestionsRaw) {
  const parsed = [];
  if (!suggestionsRaw || !Array.isArray(suggestionsRaw)) return parsed;

  for (const s of suggestionsRaw) {
    const info = s['1'] || {};
    if (!info) continue;

    const name = info['1'] || '';
    const advId = info['2'] || '';
    const country = info['3'] || '';
    const adCountRaw = info['4'] && info['4']['2'] ? info['4']['2'] : {};
    let adCount = 0;
    if (typeof adCountRaw === 'object' && adCountRaw !== null) {
      const raw = adCountRaw['1'] || '0';
      adCount = /^\d+$/.test(String(raw)) ? parseInt(raw, 10) : 0;
    }
    const verified = !!info['5'];

    if (name && advId && advId.startsWith('AR')) {
      parsed.push({ name, advertiser_id: advId, country, ad_count: adCount, verified });
    }
  }

  return parsed;
}

// ══════════════════════════════════════════════════════════════
// Name similarity scoring (ported from Python, identical logic)
// ══════════════════════════════════════════════════════════════
function nameSimilarity(candidateName, queryStr) {
  const queryLower = queryStr.toLowerCase().trim();
  const candLower = candidateName.toLowerCase().trim();

  // Exact match (case-insensitive), including with/without dots
  if (candLower === queryLower || candLower.replace(/\./g, '') === queryLower.replace(/\./g, '')) {
    return 1.0;
  }

  const bizSuffixes = new Set([
    'llc', 'inc', 'inc.', 'ltd', 'ltd.', 'co', 'co.', 'corp', 'corp.',
    'corporation', 'group', 'the', 'company', 'limited', 'gmbh', 'sa',
    'americas', 'america', 'usa', 'us', 'uk', 'international', 'global'
  ]);

  const shorter = Math.min(queryLower.length, candLower.length);
  const longer = Math.max(queryLower.length, candLower.length);
  const lengthRatio = longer > 0 ? shorter / longer : 0;

  // Check if query starts the candidate name
  if (candLower.startsWith(queryLower)) {
    const extra = candLower.slice(queryLower.length).trim().replace(/[.,]+$/, '');
    const extraWords = new Set(
      extra.split(/\s+/).map(w => w.replace(/[.,]/g, '')).filter(Boolean)
    );
    // Reject if extra words contain long numeric codes
    const hasRandomId = [...extraWords].some(w => /^\d+$/.test(w) && w.length >= 4);
    if (hasRandomId) return 0.3;
    // Check if extra words are just business suffixes
    const nonSuffix = [...extraWords].filter(w => !bizSuffixes.has(w.toLowerCase()));
    if (extraWords.size === 0 || nonSuffix.length === 0) return 0.9;
    if (lengthRatio >= 0.4) return 0.75;
    return 0.5;
  }

  // Query appears inside candidate but NOT at start
  if (candLower.includes(queryLower)) {
    if (lengthRatio >= 0.7) return 0.65;
    return 0.3;
  }

  // Candidate is contained in query
  if (queryLower.includes(candLower)) {
    if (lengthRatio >= 0.5) return 0.7;
    return 0.3;
  }

  // Bidirectional word overlap
  const noise = new Set(['llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'group', 'the']);
  const queryWords = new Set(queryLower.split(/\s+/).filter(w => !noise.has(w)));
  const candWords = new Set(candLower.replace(/[.,]/g, '').split(/\s+/).filter(w => !noise.has(w)));

  if (queryWords.size === 0 || candWords.size === 0) return 0.0;

  const overlap = [...queryWords].filter(w => candWords.has(w));
  const forward = overlap.length / queryWords.size;
  const reverse = overlap.length / candWords.size;
  return Math.min(forward, reverse);
}

function getActivityLevel(adCount) {
  return adCount > 500 ? 'Very High' :
         adCount > 100 ? 'High' :
         adCount > 30 ? 'Moderate' :
         adCount > 10 ? 'Active' :
         adCount > 0 ? 'Low' : 'None Detected';
}

function getDirectionalActivityTier(adCount) {
  return adCount > 500 ? 'High' :
         adCount > 50 ? 'Medium' :
         adCount > 0 ? 'Low' : 'None';
}

function buildEstimatedChannels(adCount) {
  const channels = ['Google Search'];
  if (adCount > 20) channels.push('Google Display Network');
  if (adCount > 50) channels.push('YouTube');
  return channels;
}

function normalizedOwnershipTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function hasAgencyAccountLanguage(value) {
  const normalized = normalizedOwnershipTokens(value).join(' ');
  if (!normalized) return false;

  const agencyPhrases = [
    'ad agency',
    'ads agency',
    'advertising agency',
    'marketing agency',
    'media agency',
    'digital agency',
    'creative agency',
    'performance marketing',
    'growth marketing',
    'paid media',
    'media buying',
    'marketing services',
    'advertising services',
    'client services',
  ];
  if (agencyPhrases.some(phrase => normalized.includes(phrase))) return true;

  const tokens = new Set(normalized.split(/\s+/));
  const agencyTerms = new Set([
    'agency',
    'agencies',
    'marketing',
    'advertising',
    'ads',
    'media',
    'performance',
    'communications',
    'consulting',
    'consultants',
  ]);
  return [...agencyTerms].some(term => tokens.has(term));
}

function hasManagedServicesRiskLanguage(value) {
  const tokens = new Set(normalizedOwnershipTokens(value));
  const riskTerms = new Set([
    'agency',
    'agencies',
    'advertising',
    'consulting',
    'consultants',
    'digital',
    'group',
    'holdings',
    'interactive',
    'management',
    'marketing',
    'media',
    'partners',
    'performance',
    'services',
    'solutions',
    'strategy',
  ]);
  return [...riskTerms].some(term => tokens.has(term));
}

function qualifyBrandAdOwnership(query, match) {
  const accountAdCount = Number(match.ad_count || 0);
  const similarity = nameSimilarity(match.name || '', query || '');
  const agencyLike = hasAgencyAccountLanguage(query) || hasAgencyAccountLanguage(match.name);
  const highVolumeManagedAccountRisk = accountAdCount >= 250 && (
    hasManagedServicesRiskLanguage(query) || hasManagedServicesRiskLanguage(match.name)
  );

  let adCountWeight = 1;
  let ownershipConfidence = 'high';
  let brandRelevance = 'direct_profile_match';
  let adCountScope = 'brand_owned_verified';
  let qualificationNote = 'Advertiser profile closely matches the searched brand; account-level Google ad count is treated as brand-owned activity.';

  if (agencyLike || highVolumeManagedAccountRisk) {
    brandRelevance = 'agency_or_multi_brand_profile';
    adCountScope = 'account_level_weighted';
    ownershipConfidence = accountAdCount > 5000 ? 'low' : accountAdCount > 1000 ? 'low' : 'medium';
    adCountWeight = accountAdCount > 10000 ? 0.03 :
                    accountAdCount > 5000 ? 0.06 :
                    accountAdCount > 3000 ? 0.12 :
                    accountAdCount > 1000 ? 0.3 :
                    accountAdCount > 250 ? 0.5 : 0.65;
    qualificationNote = 'Advertiser/profile appears agency-like or multi-brand. Google\'s account-level total may include client or third-party ads, so RespondIQ uses a weighted brand-relevant count for SOV and activity scoring.';
  } else if (similarity < 0.8) {
    brandRelevance = 'partial_profile_match';
    adCountScope = 'account_level_weighted';
    ownershipConfidence = 'medium';
    adCountWeight = 0.7;
    qualificationNote = 'Advertiser profile is a partial name match. Treat the Google count as directional unless the source link confirms the ads are owned by the brand.';
  }

  let brandRelevantAdCount = accountAdCount > 0
    ? Math.max(1, Math.round(accountAdCount * adCountWeight))
    : 0;
  if (adCountScope === 'account_level_weighted' && accountAdCount >= 10000) {
    brandRelevantAdCount = Math.min(brandRelevantAdCount, 900);
  } else if (adCountScope === 'account_level_weighted' && accountAdCount >= 5000) {
    brandRelevantAdCount = Math.min(brandRelevantAdCount, 750);
  }

  return {
    account_ad_count: accountAdCount,
    raw_ad_count: accountAdCount,
    ad_count: brandRelevantAdCount,
    ad_count_weight: Number(adCountWeight.toFixed(2)),
    ad_count_scope: adCountScope,
    exact_ad_count_allowed: adCountScope === 'brand_owned_verified' && ownershipConfidence === 'high',
    ad_count_display_mode: adCountScope === 'brand_owned_verified' && ownershipConfidence === 'high' ? 'count' : 'tier',
    google_activity_tier: getDirectionalActivityTier(adCountScope === 'brand_owned_verified' ? brandRelevantAdCount : accountAdCount),
    brand_relevance: brandRelevance,
    ownership_confidence: ownershipConfidence,
    name_match_score: Number(similarity.toFixed(2)),
    qualification_note: qualificationNote,
    account_activity_level: getActivityLevel(accountAdCount),
    activity_level: getActivityLevel(brandRelevantAdCount),
  };
}

// ══════════════════════════════════════════════════════════════
// Best-match selection logic (ported from Python, identical)
// ══════════════════════════════════════════════════════════════
function selectBestMatch(parsed, query, preferredCountries = ['US', 'GB', 'IN', 'AE']) {
  if (!parsed || parsed.length === 0) return null;

  const queryLower = query.toLowerCase().trim();
  const MIN_ADS_THRESHOLD = 5;
  const MIN_SIMILARITY = 0.6;

  // Pool: entities with meaningful ad counts
  let pool = parsed.filter(p => p.ad_count >= MIN_ADS_THRESHOLD);

  // Fallback: if no entities meet threshold, check exact/near-exact with any ads
  if (pool.length === 0) {
    pool = parsed.filter(p => {
      if (p.ad_count <= 0) return false;
      const pLower = p.name.toLowerCase().trim();
      return pLower === queryLower || pLower.replace(/\./g, '') === queryLower.replace(/\./g, '');
    });
  }

  if (pool.length === 0) return null;

  // Filter by name similarity
  const viable = pool.filter(p => nameSimilarity(p.name, query) >= MIN_SIMILARITY);
  if (viable.length === 0) return null;

  // Prefer researched countries first, then common fallback markets, then highest ad count
  const countryOrder = [
    ...preferredCountries.filter(c => c && c !== 'anywhere'),
    'US', 'GB', 'IN', 'AE'
  ].filter((c, idx, arr) => arr.indexOf(c) === idx);
  for (const preferredCountry of countryOrder) {
    const matches = viable.filter(p => p.country === preferredCountry);
    if (matches.length > 0) {
      return matches.sort((a, b) => b.ad_count - a.ad_count)[0];
    }
  }

  // No preferred country match: pick highest ad count globally
  return viable.sort((a, b) => b.ad_count - a.ad_count)[0];
}

// ══════════════════════════════════════════════════════════════
// Core: Search for a single competitor (replaces scrapeOneCompetitor)
// ══════════════════════════════════════════════════════════════
async function searchOneCompetitor(query, preferredCountries = ['US', 'GB', 'IN', 'AE']) {
  try {
    const suggestionsRaw = await fetchSuggestions(query);
    const parsed = parseSuggestions(suggestionsRaw);

    if (parsed.length === 0) {
      return { query, found: false, best_match: null, suggestions: [] };
    }

    const best = selectBestMatch(parsed, query, preferredCountries);

    return {
      query,
      found: !!best,
      best_match: best || null,
      suggestions: parsed,
    };
  } catch (err) {
    return { query, found: false, best_match: null, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// Main: Get competitive intelligence for multiple competitors
// ══════════════════════════════════════════════════════════════
async function getCompetitiveIntelligence(competitorNames, locations = ['United States']) {
  if (!competitorNames || competitorNames.length === 0) return [];

  const regionEntries = resolveTransparencyRegions(locations);
  const preferredCountries = regionEntries.map(r => r.region).filter(Boolean);
  const regionCacheKey = regionEntries.map(r => r.label + ':' + r.region).join('|');
  const results = [];

  for (const name of competitorNames) {
    const cleaned = name.trim();
    if (!cleaned) continue;

    // Remove protocol/www but KEEP domain suffix for first attempt
    const cleanedFull = cleaned
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '');

    // Fallback query strips domain suffix for broader search
    const cleanedShort = cleanedFull
      .replace(/\.(com|co\.uk|io|net|org|ai)$/i, '');

    // Check cache
    const cacheKey = 'ci:' + cleanedFull.toLowerCase() + ':' + regionCacheKey;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push(cached.data);
      continue;
    }

    // Try full name first, then short name if no match
    console.log('[RespondIQ] Querying Google Ads Transparency for:', cleanedFull);
    let raw = await searchOneCompetitor(cleanedFull, preferredCountries);

    if ((!raw.found || !raw.best_match) && cleanedShort !== cleanedFull) {
      console.log('[RespondIQ] Retrying Transparency with shorter query:', cleanedShort);
      raw = await searchOneCompetitor(cleanedShort, preferredCountries);
    }

    let structured;
    if (raw.found && raw.best_match) {
      const match = raw.best_match;
      const ownership = qualifyBrandAdOwnership(cleanedFull, match);
      const adCount = ownership.ad_count || 0;
      const channels = buildEstimatedChannels(adCount);

      structured = {
        query: cleaned,
        found: true,
        name: match.name,
        advertiser_id: match.advertiser_id,
        country: match.country,
        account_ad_count: ownership.account_ad_count,
        raw_ad_count: ownership.raw_ad_count,
        ad_count: adCount,
        ad_count_weight: ownership.ad_count_weight,
        ad_count_scope: ownership.ad_count_scope,
        exact_ad_count_allowed: ownership.exact_ad_count_allowed,
        ad_count_display_mode: ownership.ad_count_display_mode,
        google_activity_tier: ownership.google_activity_tier,
        brand_relevance: ownership.brand_relevance,
        ownership_confidence: ownership.ownership_confidence,
        name_match_score: ownership.name_match_score,
        qualification_note: ownership.qualification_note,
        verified: match.verified,
        account_activity_level: ownership.account_activity_level,
        activity_level: ownership.activity_level,
        estimated_channels: channels,
        transparency_region: regionEntries[0]?.region || 'US',
        transparency_url: buildTransparencyUrl(match.advertiser_id, regionEntries[0]?.region || 'US'),
        transparency_urls: regionEntries.map(entry => ({
          label: entry.label,
          region: entry.region,
          url: buildTransparencyUrl(match.advertiser_id, entry.region),
        })),
      };
      const ownershipSuffix = ownership.ad_count_scope === 'account_level_weighted'
        ? ` | account total: ${ownership.account_ad_count} | weighted brand count: ${adCount} | ownership: ${ownership.ownership_confidence}`
        : '';
      console.log('[RespondIQ] Found:', match.name, '|', adCount, 'brand-relevant ads |', match.country, ownershipSuffix);
    } else {
      structured = {
        query: cleaned,
        found: false,
        reason: raw.error || 'Not found in Google Ads Transparency Center',
      };
      console.log('[RespondIQ] Not found:', cleaned, '|', raw.error || 'no results');
    }

    cache.set(cacheKey, { data: structured, timestamp: Date.now() });
    results.push(structured);

    // Rate limit between API calls (be respectful to Google)
    if (competitorNames.indexOf(name) < competitorNames.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════════
// Build the prompt injection block for the AI model
// ══════════════════════════════════════════════════════════════
function buildCompetitorPromptBlock(results) {
  if (!results || results.length === 0) return '';

  const found = results.filter(r => r.found);
  const notFound = results.filter(r => !r.found);

  if (found.length === 0) return '';

  let block = '\nRULE 16 — REAL-TIME COMPETITIVE AD INTELLIGENCE (from Google Ads Transparency Center):\n';
  block += 'The following competitor data was auto-retrieved from Google\'s public Ads Transparency database. Google verifies the advertiser account/profile, but advertiser profiles can include ads run for client brands. For agency, media, consulting, or multi-brand profiles, use only a directional activity tier and never treat the profile-level ad total as brand-owned activity.\n\n';

  for (const comp of found) {
    const allowExactCount = comp.exact_ad_count_allowed !== false && (comp.ad_count_display_mode || 'count') === 'count';
    block += `VERIFIED: ${comp.name} (${comp.country})\n`;
    block += `- Google Ads Transparency advertiser ID: ${comp.advertiser_id}\n`;
    block += `- Ad count scope: ${comp.ad_count_scope || 'brand_owned_verified'}\n`;
    block += `- Ownership confidence: ${comp.ownership_confidence || 'high'}\n`;
    block += `- Name match score: ${comp.name_match_score ?? 'n/a'}\n`;
    if (allowExactCount) {
      block += `- Brand-owned active Google ads: ${comp.ad_count}\n`;
    } else {
      block += `- Directional Google activity tier: ${comp.google_activity_tier || comp.activity_level || 'Medium'}\n`;
      block += '- Exact Google ad count: withheld from narrative because this profile may include client or third-party ads\n';
    }
    if (comp.qualification_note) {
      block += `- Qualification note: ${comp.qualification_note}\n`;
    }
    block += `- Google activity level for planning: ${allowExactCount ? comp.activity_level : (comp.google_activity_tier || comp.activity_level)}\n`;
    block += `- Google-verified advertiser: ${comp.verified ? 'Yes' : 'No'}\n`;
    block += `- Estimated Google channels: ${comp.estimated_channels.join(', ')}\n`;
    if (Array.isArray(comp.transparency_urls) && comp.transparency_urls.length > 0) {
      block += `- Source links by searched location: ${comp.transparency_urls.map(u => `${u.label} (${u.region}): ${u.url}`).join(' | ')}\n\n`;
    } else {
      block += `- Source link: ${comp.transparency_url}\n\n`;
    }
  }

  if (notFound.length > 0) {
    block += `NOT FOUND in Transparency Center: ${notFound.map(n => n.query).join(', ')}. For these, use industry knowledge and label all data as "AI-estimated."\n\n`;
  }

  block += 'INSTRUCTIONS FOR USING THIS DATA:\n';
  block += '- Reference exact Google ad counts ONLY when exact_ad_count_allowed is true\n';
  block += '- When exact_ad_count_allowed is false, use only High/Medium/Low Google activity wording; do NOT write a numeric Google ad count anywhere in the plan\n';
  block += '- Use directional activity tiers to estimate relative spend (High activity = likely higher spend), but keep SOV and spend estimates conservative for agency-style accounts\n';
  block += '- Do not inflate SOV or spend from raw account-level totals when ad_count_scope is not "brand_owned_verified"\n';
  block += '- If ownership confidence is medium or low, explicitly note that the Google advertiser profile may include client or third-party ads\n';
  block += '- Treat agency or multi-brand profiles as directional competitive signals unless the source link clearly shows brand-owned creative\n';
  block += '- Label account/profile source data as "verified via Google Ads Transparency"; label non-exact activity tiers as "directional due to possible client ads"\n';
  block += '- This covers Google platforms ONLY. For Meta, LinkedIn, TikTok channels, supplement with industry knowledge and label as "estimated"\n';
  block += '- Set ai_data_confidence to "medium" when Transparency data is available (upgrade from "low")\n';

  return block;
}

module.exports = {
  getCompetitiveIntelligence,
  buildCompetitorPromptBlock,
};
