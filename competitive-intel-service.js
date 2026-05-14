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

// ══════════════════════════════════════════════════════════════
// Best-match selection logic (ported from Python, identical)
// ══════════════════════════════════════════════════════════════
function selectBestMatch(parsed, query) {
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

  // Prefer US > GB > IN > AE, then highest ad count
  for (const preferredCountry of ['US', 'GB', 'IN', 'AE']) {
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
async function searchOneCompetitor(query) {
  try {
    const suggestionsRaw = await fetchSuggestions(query);
    const parsed = parseSuggestions(suggestionsRaw);

    if (parsed.length === 0) {
      return { query, found: false, best_match: null, suggestions: [] };
    }

    const best = selectBestMatch(parsed, query);

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
async function getCompetitiveIntelligence(competitorNames) {
  if (!competitorNames || competitorNames.length === 0) return [];

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
    const cacheKey = 'ci:' + cleanedFull.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push(cached.data);
      continue;
    }

    // Try full name first, then short name if no match
    console.log('[RespondIQ] Querying Google Ads Transparency for:', cleanedFull);
    let raw = await searchOneCompetitor(cleanedFull);

    if ((!raw.found || !raw.best_match) && cleanedShort !== cleanedFull) {
      console.log('[RespondIQ] Retrying Transparency with shorter query:', cleanedShort);
      raw = await searchOneCompetitor(cleanedShort);
    }

    let structured;
    if (raw.found && raw.best_match) {
      const match = raw.best_match;
      const adCount = match.ad_count || 0;

      const activityLevel = adCount > 500 ? 'Very High' :
                            adCount > 100 ? 'High' :
                            adCount > 30 ? 'Moderate' :
                            adCount > 10 ? 'Active' :
                            adCount > 0 ? 'Low' : 'None Detected';

      const channels = ['Google Search'];
      if (adCount > 20) channels.push('Google Display Network');
      if (adCount > 50) channels.push('YouTube');

      structured = {
        query: cleaned,
        found: true,
        name: match.name,
        advertiser_id: match.advertiser_id,
        country: match.country,
        ad_count: adCount,
        verified: match.verified,
        activity_level: activityLevel,
        estimated_channels: channels,
        transparency_url: `https://adstransparency.google.com/advertiser/${match.advertiser_id}`,
      };
      console.log('[RespondIQ] Found:', match.name, '|', adCount, 'ads |', match.country);
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
// (Unchanged from v1)
// ══════════════════════════════════════════════════════════════
function buildCompetitorPromptBlock(results) {
  if (!results || results.length === 0) return '';

  const found = results.filter(r => r.found);
  const notFound = results.filter(r => !r.found);

  if (found.length === 0) return '';

  let block = '\nRULE 16 — REAL-TIME COMPETITIVE AD INTELLIGENCE (from Google Ads Transparency Center):\n';
  block += 'The following competitor data was auto-retrieved from Google\'s public Ads Transparency database. Use these VERIFIED data points in your competitive analysis. Do NOT override these numbers with estimates.\n\n';

  for (const comp of found) {
    block += `VERIFIED: ${comp.name} (${comp.country})\n`;
    block += `- Google Ads Transparency advertiser ID: ${comp.advertiser_id}\n`;
    block += `- Total active Google ads: ${comp.ad_count}\n`;
    block += `- Advertising activity level: ${comp.activity_level}\n`;
    block += `- Google-verified advertiser: ${comp.verified ? 'Yes' : 'No'}\n`;
    block += `- Estimated Google channels: ${comp.estimated_channels.join(', ')}\n`;
    block += `- Source link: ${comp.transparency_url}\n\n`;
  }

  if (notFound.length > 0) {
    block += `NOT FOUND in Transparency Center: ${notFound.map(n => n.query).join(', ')}. For these, use industry knowledge and label all data as "AI-estimated."\n\n`;
  }

  block += 'INSTRUCTIONS FOR USING THIS DATA:\n';
  block += '- Reference verified ad counts in the competitive_sov section\n';
  block += '- Use activity levels to estimate relative spend (High activity = likely higher spend)\n';
  block += '- Label data from Transparency Center as "verified via Google Ads Transparency"\n';
  block += '- This covers Google platforms ONLY. For Meta, LinkedIn, TikTok channels, supplement with industry knowledge and label as "estimated"\n';
  block += '- Set ai_data_confidence to "medium" when Transparency data is available (upgrade from "low")\n';

  return block;
}

module.exports = {
  getCompetitiveIntelligence,
  buildCompetitorPromptBlock,
};
