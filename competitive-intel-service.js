// ══════════════════════════════════════════════════════════════
// competitive-intel-service.js
// Google Ads Transparency Center - FREE Competitive Intelligence
// Uses reverse-engineered internal API (no paid keys, no browser)
// Mirrors keyword-service.js pattern for consistency
// ══════════════════════════════════════════════════════════════

// ── In-memory cache (competitor data is stable within a day) ──
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// ── Google Ads Transparency Center internal endpoints ──
const TRANSPARENCY_BASE = 'https://adstransparency.google.com';
const SEARCH_ENDPOINT = TRANSPARENCY_BASE + '/anji/_/rpc/SearchService/SearchCreatives';
const SUGGEST_ENDPOINT = TRANSPARENCY_BASE + '/anji/_/rpc/SearchService/GetSuggestions';

// ── Common headers that mimic the Transparency Center frontend ──
function getHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': TRANSPARENCY_BASE,
    'Referer': TRANSPARENCY_BASE + '/',
  };
}

// ══════════════════════════════════════════════════════════════
// Core: Search for an advertiser by name/keyword
// Returns suggestions with advertiser name, ID, country, ad count
// ══════════════════════════════════════════════════════════════
async function searchAdvertiser(query) {
  const cacheKey = 'search:' + query.toLowerCase().trim();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    // The Transparency Center uses a protobuf-like format over HTTP
    // The request body is form-encoded with a JSON-like nested structure
    const requestBody = `f.req=${encodeURIComponent(JSON.stringify([[query, null, null, null, null, null, null, [20]]]))}&`;

    const response = await fetch(SUGGEST_ENDPOINT, {
      method: 'POST',
      headers: getHeaders(),
      body: requestBody,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Fallback: try the simpler search approach
      return await searchAdvertiserFallback(query);
    }

    const text = await response.text();
    const suggestions = parseSuggestionResponse(text, query);

    cache.set(cacheKey, { data: suggestions, timestamp: Date.now() });
    return suggestions;

  } catch (error) {
    console.warn('[RespondIQ] Transparency direct search failed for', query, ':', error.message);
    // Try fallback
    return await searchAdvertiserFallback(query);
  }
}

// ── Fallback: use the public-facing search URL and parse the response ──
async function searchAdvertiserFallback(query) {
  try {
    const url = `${TRANSPARENCY_BASE}?text=${encodeURIComponent(query)}&region=anywhere`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RespondIQ/2.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();

    // Extract any advertiser data from the initial page state
    // The Transparency Center embeds data in script tags
    const dataMatch = html.match(/AF_initDataCallback\({[^}]*key:\s*'ds:1'[^}]*data:([\s\S]*?)\}\);/);
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        return parseEmbeddedData(data, query);
      } catch (e) { /* parsing failed, return empty */ }
    }

    return [];
  } catch (error) {
    console.warn('[RespondIQ] Transparency fallback also failed for', query);
    return [];
  }
}

// ── Parse the suggestion response from Google's internal API ──
function parseSuggestionResponse(responseText, query) {
  try {
    // Google returns a weird format with )]}' prefix and nested arrays
    let cleaned = responseText;
    if (cleaned.startsWith(")]}'")) {
      cleaned = cleaned.substring(4).trim();
    }

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (e) {
      // Sometimes it's double-wrapped
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        return [];
      }
    }

    // Navigate the nested structure to find advertiser suggestions
    const suggestions = [];
    const extractFromArray = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (Array.isArray(item)) {
          // Look for the pattern: [name, advertiserID, country, [null, [adCount, adCount]], verified]
          if (typeof item[0] === 'string' && typeof item[1] === 'string' && item[1].startsWith('AR')) {
            suggestions.push({
              name: item[0],
              advertiser_id: item[1],
              country: item[2] || 'Unknown',
              ad_count: (item[3] && item[3][1] && item[3][1][0]) ? parseInt(item[3][1][0]) : 0,
              verified: !!item[4],
            });
          } else {
            extractFromArray(item);
          }
        }
      }
    };

    extractFromArray(data);
    return suggestions;

  } catch (error) {
    return [];
  }
}

function parseEmbeddedData(data, query) {
  // Embedded data has a different structure, try to extract what we can
  const suggestions = [];
  try {
    const extractRecursive = (obj) => {
      if (Array.isArray(obj)) {
        if (obj.length >= 3 && typeof obj[0] === 'string' && typeof obj[1] === 'string' && obj[1].startsWith('AR')) {
          suggestions.push({
            name: obj[0],
            advertiser_id: obj[1],
            country: obj[2] || 'Unknown',
            ad_count: 0,
            verified: false,
          });
        }
        obj.forEach(extractRecursive);
      } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(extractRecursive);
      }
    };
    extractRecursive(data);
  } catch (e) { /* ignore */ }
  return suggestions;
}

// ══════════════════════════════════════════════════════════════
// Pick the best match from suggestions
// Prefers: US > GB > IN > highest ad count
// ══════════════════════════════════════════════════════════════
function pickBestMatch(suggestions, query) {
  if (!suggestions || suggestions.length === 0) return null;

  // Filter out zero-ad entries
  const withAds = suggestions.filter(s => s.ad_count > 0);
  const pool = withAds.length > 0 ? withAds : suggestions;

  // Priority: US, then GB, then by ad count
  const priority = ['US', 'GB', 'IN', 'AE'];
  for (const country of priority) {
    const matches = pool.filter(s => s.country === country);
    if (matches.length > 0) {
      return matches.sort((a, b) => b.ad_count - a.ad_count)[0];
    }
  }

  // No priority country match, return highest ad count
  return pool.sort((a, b) => b.ad_count - a.ad_count)[0];
}

// ══════════════════════════════════════════════════════════════
// Main: Get competitive intelligence for multiple competitors
// Returns structured data ready for prompt injection
// ══════════════════════════════════════════════════════════════
async function getCompetitiveIntelligence(competitorNames) {
  if (!competitorNames || competitorNames.length === 0) return null;

  const results = [];

  for (const name of competitorNames) {
    const cleaned = name.trim();
    if (!cleaned) continue;

    // Remove domain suffixes for search (google searches better by name)
    const searchQuery = cleaned
      .replace(/\.(com|co\.uk|io|net|org|ai)$/i, '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '');

    try {
      const suggestions = await searchAdvertiser(searchQuery);
      const best = pickBestMatch(suggestions, searchQuery);

      if (best && best.ad_count > 0) {
        const activityLevel = best.ad_count > 500 ? 'Very High' :
                              best.ad_count > 100 ? 'High' :
                              best.ad_count > 30 ? 'Moderate' :
                              best.ad_count > 10 ? 'Active' :
                              best.ad_count > 0 ? 'Low' : 'None Detected';

        // Estimate channels from ad volume
        const channels = ['Google Search'];
        if (best.ad_count > 20) channels.push('Google Display Network');
        if (best.ad_count > 50) channels.push('YouTube');

        results.push({
          query: cleaned,
          found: true,
          name: best.name,
          advertiser_id: best.advertiser_id,
          country: best.country,
          ad_count: best.ad_count,
          verified: best.verified,
          activity_level: activityLevel,
          estimated_channels: channels,
          transparency_url: `https://adstransparency.google.com/advertiser/${best.advertiser_id}`,
          all_suggestions_count: suggestions.length,
        });
      } else {
        results.push({
          query: cleaned,
          found: false,
          reason: suggestions.length > 0 ? 'Found entries but no active ads' : 'Not found in Google Ads Transparency Center',
        });
      }
    } catch (error) {
      console.error('[RespondIQ] Competitive intel failed for', cleaned, ':', error.message);
      results.push({
        query: cleaned,
        found: false,
        reason: error.message,
      });
    }

    // Rate limit between requests
    if (competitorNames.indexOf(name) < competitorNames.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════════
// Build the prompt injection block for the AI model
// This is what gets inserted into the RespondIQ prompt
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
