// ══════════════════════════════════════════════════════════════
// meta-ads-service.js
// Meta Ad Library competitive intelligence using native fetch.
// Covers Facebook, Instagram, Messenger, and Threads active ads.
// ══════════════════════════════════════════════════════════════

const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours
const RATE_LIMIT_TTL = 5 * 60 * 1000;  // 5 minutes
const META_LIMIT = 50;

let missingTokenWarned = false;
let disabledForProcess = false;
let disabledReason = '';
let disabledLogged = false;
let rateLimitUntil = 0;

const COUNTRY_REGION_CODES = {
  'united states': 'US',
  'global / worldwide': 'US',
  'global': 'US',
  'worldwide': 'US',
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

const META_FIELDS = [
  'id',
  'ad_creation_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_snapshot_url',
  'page_id',
  'page_name',
  'publisher_platforms',
  'languages'
].join(',');

function normalizeLocationList(locations) {
  if (Array.isArray(locations)) return locations.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof locations === 'string') return locations.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function resolveMetaRegion(location) {
  const label = String(location || '').trim() || 'United States';
  const normalized = label.toLowerCase();

  if (COUNTRY_REGION_CODES[normalized]) return COUNTRY_REGION_CODES[normalized];
  if (US_SUBREGIONS.has(normalized) || normalized.includes(' dma') || normalized.endsWith(' dma')) return 'US';
  if (UK_SUBREGIONS.has(normalized)) return 'GB';
  if (/^[A-Z]{2}$/.test(label)) return label;

  return 'US';
}

function resolveMetaRegions(locations) {
  const list = normalizeLocationList(locations);
  const source = list.length > 0 ? list : ['United States'];
  const seen = new Set();
  const regions = [];

  for (const item of source) {
    const region = resolveMetaRegion(item);
    if (!seen.has(region)) {
      seen.add(region);
      regions.push(region);
    }
    if (regions.length >= 3) break;
  }

  return regions.length ? regions : ['US'];
}

function buildAdLibraryUrl(pageId, region) {
  return 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=' +
    encodeURIComponent(region || 'US') +
    '&view_all_page_id=' +
    encodeURIComponent(pageId);
}

function cleanCompetitorName(name) {
  return String(name || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\.(com|co\.uk|io|net|org|ai)$/i, '')
    .trim();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBusinessWords(words) {
  const noise = new Set([
    'the', 'llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group',
    'official', 'usa', 'us', 'uk', 'global', 'international', 'page'
  ]);
  return words.filter(w => w && !noise.has(w));
}

function levenshteinRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const prev = Array(b.length + 1).fill(0).map((_, i) => i);
  const curr = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  const distance = prev[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function fuzzyMatchScore(pageName, query) {
  const page = normalizeName(pageName);
  const q = normalizeName(query);
  if (!page || !q) return 0;
  if (page === q) return 1;

  const pageCompact = page.replace(/\s+/g, '');
  const qCompact = q.replace(/\s+/g, '');
  if (pageCompact === qCompact) return 1;

  let substringScore = 0;
  if (pageCompact.includes(qCompact) || qCompact.includes(pageCompact)) {
    const shorter = Math.min(pageCompact.length, qCompact.length);
    const longer = Math.max(pageCompact.length, qCompact.length);
    substringScore = Math.max(0.55, shorter / longer);
  }

  const pageWords = stripBusinessWords(page.split(/\s+/));
  const queryWords = stripBusinessWords(q.split(/\s+/));
  let tokenScore = 0;
  if (pageWords.length && queryWords.length) {
    const pageSet = new Set(pageWords);
    const querySet = new Set(queryWords);
    const overlap = [...querySet].filter(w => pageSet.has(w)).length;
    const precision = overlap / pageSet.size;
    const recall = overlap / querySet.size;
    tokenScore = Math.min(precision, recall);
  }

  return Math.max(
    levenshteinRatio(pageCompact, qCompact),
    substringScore,
    tokenScore
  );
}

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)).replace(/\s+\S*$/, '') + '...';
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function isoDateOnly(value) {
  if (!value) return null;
  const text = String(value);
  return text.includes('T') ? text.split('T')[0] : text.slice(0, 10);
}

function activityLevel(adCount) {
  if (adCount > 100) return 'Very High';
  if (adCount > 30) return 'High';
  if (adCount > 10) return 'Moderate';
  if (adCount > 0) return 'Low';
  return 'None Detected';
}

function publicAdActivityLabel(value, adCount) {
  const text = String(value || '').toLowerCase();
  const n = Number(adCount || 0);
  if (/very high|high/.test(text) || n > 100) return 'High ad activity';
  if (/moderate|medium|active/.test(text) || n > 20) return 'Medium ad activity';
  if (/low/.test(text) || n > 0) return 'Low ad activity';
  return 'Nil ad activity';
}

function uniqueLower(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim().toLowerCase();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function extractMetaError(payload) {
  return payload && payload.error ? payload.error : null;
}

function handleMetaError(error, status) {
  const code = Number(error && error.code);
  const subcode = Number(error && (error.error_subcode || error.subcode));
  const message = (error && error.message) || ('HTTP ' + status);

  console.warn('[RespondIQ] Meta Ad Library error:', message);

  if (code === 4 || code === 17) {
    rateLimitUntil = Date.now() + RATE_LIMIT_TTL;
    return { found: false, reason: 'Meta rate limit', rateLimited: true };
  }

  if ((code === 10 && subcode === 2332002) || code === 190) {
    disabledForProcess = true;
    disabledReason = code === 190 ? 'Meta token expired or invalid' : 'Meta identity verification incomplete';
    if (!disabledLogged) {
      console.warn('[RespondIQ] Meta Ad Library disabled:', disabledReason);
      disabledLogged = true;
    }
    return { found: false, reason: disabledReason, disabled: true };
  }

  if (code === 100) {
    return { found: false, reason: 'Meta invalid parameter' };
  }

  if (status >= 500) {
    return { found: false, reason: 'Meta API unavailable' };
  }

  return { found: false, reason: message || 'Meta API error' };
}

async function fetchMetaAds(query, region, token) {
  const params = new URLSearchParams({
    access_token: token,
    search_terms: query,
    ad_reached_countries: JSON.stringify([region]),
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    limit: String(META_LIMIT),
    fields: META_FIELDS,
  });

  try {
    const res = await fetch('https://graph.facebook.com/v25.0/ads_archive?' + params.toString(), {
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    const metaError = extractMetaError(payload);
    if (!res.ok || metaError) {
      return handleMetaError(metaError || { message: 'HTTP ' + res.status }, res.status);
    }

    return { found: true, ads: Array.isArray(payload && payload.data) ? payload.data : [] };
  } catch (err) {
    console.warn('[RespondIQ] Meta Ad Library error:', err.message);
    return { found: false, reason: 'Meta API unavailable' };
  }
}

function buildRegionResult(query, region, ads) {
  const grouped = new Map();
  for (const ad of ads) {
    const pageId = ad && ad.page_id ? String(ad.page_id) : '';
    if (!pageId) continue;
    if (!grouped.has(pageId)) {
      grouped.set(pageId, {
        page_id: pageId,
        page_name: ad.page_name || '',
        ads: [],
      });
    }
    grouped.get(pageId).ads.push(ad);
  }

  let best = null;
  for (const page of grouped.values()) {
    const score = fuzzyMatchScore(page.page_name, query);
    if (score < 0.5) continue;
    if (!best || score > best.score || (score === best.score && page.ads.length > best.ads.length)) {
      best = { ...page, score };
    }
  }

  if (!best) {
    return { query, found: false, reason: 'No high-confidence Meta page match' };
  }

  const sortedAds = best.ads.slice().sort((a, b) => {
    const aTime = Date.parse(a.ad_delivery_start_time || a.ad_creation_time || '') || 0;
    const bTime = Date.parse(b.ad_delivery_start_time || b.ad_creation_time || '') || 0;
    return bTime - aTime;
  });

  const creativeSamples = sortedAds.slice(0, 3).map(ad => ({
    ad_id: String(ad.id || ''),
    headline: firstArrayValue(ad.ad_creative_link_titles) || null,
    body: truncate(firstArrayValue(ad.ad_creative_bodies) || '', 200),
    ad_snapshot_url: ad.ad_snapshot_url || '',
    delivery_start: isoDateOnly(ad.ad_delivery_start_time || ad.ad_creation_time),
    still_running: !ad.ad_delivery_stop_time,
  }));

  const platforms = uniqueLower(sortedAds.flatMap(ad => Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : []));
  const languages = uniqueLower(sortedAds.flatMap(ad => Array.isArray(ad.languages) ? ad.languages : []));
  const adCount = best.ads.length;
  const adLibraryUrl = buildAdLibraryUrl(best.page_id, region);

  return {
    query,
    found: true,
    page_name: best.page_name,
    page_id: best.page_id,
    match_confidence: best.score >= 0.8 ? 'high' : 'medium',
    ad_count: adCount,
    ad_count_indicator: adCount >= META_LIMIT ? adCount + '+' : String(adCount),
    activity_level: activityLevel(adCount),
    platforms,
    languages,
    creative_samples: creativeSamples,
    ad_library_url: adLibraryUrl,
    region,
  };
}

async function searchCompetitorRegion(query, region, token) {
  const fetched = await fetchMetaAds(query, region, token);
  if (!fetched.found) return { query, ...fetched };
  if (!fetched.ads.length) return { query, found: false, reason: 'No active Meta ads found' };
  return buildRegionResult(query, region, fetched.ads);
}

function mergeRegionResults(query, regionResults) {
  const found = regionResults.filter(r => r.found);
  if (!found.length) {
    const firstReason = (regionResults.find(r => r.reason) || {}).reason || 'No high-confidence Meta page match';
    return { query, found: false, reason: firstReason };
  }

  const canonical = found.slice().sort((a, b) => b.ad_count - a.ad_count)[0];
  const regionsActive = found
    .map(r => ({ region: r.region, ad_count: r.ad_count, ad_library_url: r.ad_library_url }))
    .sort((a, b) => b.ad_count - a.ad_count);

  const platforms = uniqueLower(found.flatMap(r => r.platforms || []));
  const languages = uniqueLower(found.flatMap(r => r.languages || []));

  return {
    query,
    found: true,
    page_name: canonical.page_name,
    page_id: canonical.page_id,
    match_confidence: canonical.match_confidence,
    ad_count: canonical.ad_count,
    ad_count_indicator: canonical.ad_count_indicator,
    activity_level: activityLevel(canonical.ad_count),
    platforms,
    languages,
    creative_samples: canonical.creative_samples || [],
    ad_library_url: canonical.ad_library_url,
    region: canonical.region,
    regions_active: regionsActive,
  };
}

function rateLimitResult(query) {
  return { query, found: false, reason: 'Meta rate limit' };
}

async function getMetaAdsIntelligence(competitorNames, locations = ['United States']) {
  if (!competitorNames || competitorNames.length === 0) return [];

  if (disabledForProcess) return [];

  const token = process.env.META_ADS_API_TOKEN;
  if (!token) {
    if (!missingTokenWarned) {
      console.warn('[RespondIQ] Meta Ad Library: META_ADS_API_TOKEN not configured; skipping Meta verified intel');
      missingTokenWarned = true;
    }
    return [];
  }

  const cleanedNames = competitorNames.map(cleanCompetitorName).filter(Boolean);
  if (!cleanedNames.length) return [];

  const regions = resolveMetaRegions(locations);
  console.log('[RespondIQ] Meta Ad Library: querying ' + cleanedNames.length + ' competitors in regions: ' + regions.join(', '));

  if (rateLimitUntil && Date.now() < rateLimitUntil) {
    return cleanedNames.map(rateLimitResult);
  }

  const regionCacheKey = regions.join('|');
  const results = [];

  for (let i = 0; i < cleanedNames.length; i++) {
    const name = cleanedNames[i];
    const cacheKey = 'meta:' + name.toLowerCase() + ':' + regionCacheKey;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push(cached.data);
    } else {
      const regionResults = await Promise.all(regions.map(region => searchCompetitorRegion(name, region, token)));

      if (disabledForProcess) return [];

      const rateLimited = regionResults.some(r => r.rateLimited);
      const merged = rateLimited ? rateLimitResult(name) : mergeRegionResults(name, regionResults);

      cache.set(cacheKey, { data: merged, timestamp: Date.now() });
      results.push(merged);

      if (merged.found) {
        console.log('[RespondIQ] Meta Ad Library: matched ' + name + ' -> ' + merged.page_name +
          ' (page_id: ' + merged.page_id + ', confidence: ' + merged.match_confidence + ', ads: ' + merged.ad_count + ')');
      } else {
        console.log('[RespondIQ] Meta Ad Library: no match for ' + name);
      }

      if (rateLimited) {
        for (let j = i + 1; j < cleanedNames.length; j++) {
          const skipped = rateLimitResult(cleanedNames[j]);
          cache.set('meta:' + cleanedNames[j].toLowerCase() + ':' + regionCacheKey, { data: skipped, timestamp: Date.now() });
          results.push(skipped);
        }
        break;
      }
    }

    if (i < cleanedNames.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const highConfidenceCount = results.filter(r => r.found && r.match_confidence === 'high').length;
  console.log('[RespondIQ] Meta Ad Library: found ' + highConfidenceCount + ' of ' + cleanedNames.length + ' high-confidence matches');
  return results;
}

function quote(value, max = 140) {
  const text = truncate(value, max).replace(/"/g, "'");
  return '"' + text + '"';
}

function buildMetaAdsPromptBlock(results) {
  if (!results || results.length === 0) return '';

  const found = results.filter(r => r.found);
  const notFound = results.filter(r => !r.found);
  if (found.length === 0) return '';

  let block = '\nRULE 18 — META AD LIBRARY COMPETITIVE INTELLIGENCE:\n';
  block += 'The following competitor data was auto-retrieved from Meta Ad Library. Use these VERIFIED data points for Facebook, Instagram, Messenger, and Threads activity. Do NOT infer spend, impressions, demographic, or reach data from Meta because commercial ads do not expose those fields in non-EU markets.\n\n';

  for (const comp of found) {
    const platforms = (comp.platforms || []).length ? comp.platforms.join(', ') : 'not specified';
    const languages = (comp.languages || []).length ? comp.languages.join(', ') : 'not specified';
    const publicActivity = publicAdActivityLabel(comp.activity_level, comp.ad_count);
    const regions = Array.isArray(comp.regions_active) && comp.regions_active.length
      ? comp.regions_active.map(r => r.region + ' (' + publicAdActivityLabel(null, r.ad_count) + ')').join(', ')
      : comp.region;

    block += 'META VERIFIED: ' + comp.page_name + ' (query: ' + comp.query + ')\n';
    block += '- Meta page ID: ' + comp.page_id + '\n';
    block += '- Match confidence: ' + comp.match_confidence + (comp.match_confidence === 'medium' ? ' (Meta match: medium confidence; treat as directional)' : '') + '\n';
    block += '- Meta ad activity for planning: ' + publicActivity + '\n';
    block += '- Exact Meta ad count: withheld from narrative; user-facing plans must show only High/Medium/Low/Nil activity tiers\n';
    block += '- Active on: ' + platforms + '\n';
    block += '- Language coverage: ' + languages + '\n';
    block += '- Regions active: ' + regions + '\n';
    block += '- Source link: ' + comp.ad_library_url + '\n';

    const samples = (comp.creative_samples || []).slice(0, 2);
    if (samples.length) {
      block += '- Creative excerpts:\n';
      for (const sample of samples) {
        const headline = sample.headline ? quote(sample.headline, 80) : '"No headline"';
        const body = sample.body ? quote(sample.body, 160) : '"No body copy available"';
        block += '  - ' + headline + ' / ' + body + (sample.delivery_start ? ' (started ' + sample.delivery_start + ')' : '') + '\n';
      }
    }
    block += '\n';
  }

  if (notFound.length > 0) {
    block += 'NOT FOUND in Meta Ad Library: ' + notFound.map(n => n.query).join(', ') + '. For these, use industry knowledge and label all Meta-channel activity as "AI-estimated."\n\n';
  }

  block += 'INSTRUCTIONS FOR USING THIS DATA:\n';
  block += '- Label all data points sourced from this block as "verified via Meta Ad Library"\n';
  block += '- Use Meta creative excerpts to inform Section 12 competitive SOV and creative strategy recommendations\n';
  block += '- Treat medium-confidence matches as directional and explicitly flag them as "Meta match: medium confidence" in any narrative\n';
  block += '- Use only High/Medium/Low/Nil Meta activity wording in the plan; do NOT write a numeric Meta ad count anywhere in the plan\n';
  block += '- If Meta data is the only verified competitive source, set ai_data_confidence to "medium"; if Google Transparency and Meta data are both present, "high" is acceptable\n';

  return block;
}

module.exports = {
  getMetaAdsIntelligence,
  buildMetaAdsPromptBlock,
};
