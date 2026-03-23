// ══════════════════════════════════════════════════════════════
// competitive-intel-service.js
// Google Ads Transparency Center - FREE Competitive Intelligence
// Uses Python bridge to reverse-engineered Google internal API
// ══════════════════════════════════════════════════════════════

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── In-memory cache (competitor data is stable within a day) ──
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// ── Python scraper script (embedded, auto-written to disk on first call) ──
const PYTHON_SCRIPT = `
import sys
import json

def search_competitor(query):
    result = {
        "query": query,
        "found": False,
        "best_match": None,
        "suggestions": []
    }

    try:
        from GoogleAds import GoogleAds
        a = GoogleAds()

        suggestions_raw = a.get_all_search_suggestions(query)
        if not suggestions_raw or not isinstance(suggestions_raw, list):
            return result

        parsed = []
        for s in suggestions_raw:
            info = s.get("1", {})
            if not info:
                continue
            name = info.get("1", "")
            adv_id = info.get("2", "")
            country = info.get("3", "")
            ad_count_raw = info.get("4", {}).get("2", {})
            ad_count = "0"
            if isinstance(ad_count_raw, dict):
                ad_count = ad_count_raw.get("1", "0")
            verified = info.get("5", False)

            if name and adv_id and adv_id.startswith("AR"):
                parsed.append({
                    "name": name,
                    "advertiser_id": adv_id,
                    "country": country,
                    "ad_count": int(ad_count) if str(ad_count).isdigit() else 0,
                    "verified": bool(verified)
                })

        result["suggestions"] = parsed

        if not parsed:
            return result

        # Pick best match: require name similarity, then prefer US > GB > highest ad count
        with_ads = [p for p in parsed if p["ad_count"] > 0]
        pool = with_ads if with_ads else parsed

        query_lower = query.lower().strip()
        query_words = set(query_lower.split())

        def name_similarity(candidate_name):
            """Score 0.0 to 1.0 based on how well the candidate name matches the query.
            Uses bidirectional word overlap to reject false positives like
            'That Company' matching 'That One Tech Company'."""
            cand_lower = candidate_name.lower().strip()
            # Exact match (case-insensitive)
            if cand_lower == query_lower:
                return 1.0
            # Check if query is contained in candidate or vice versa
            # Guard: require length ratio >= 0.5 to prevent "Monday" matching "LOUIS MONDAY"
            shorter = min(len(query_lower), len(cand_lower))
            longer = max(len(query_lower), len(cand_lower))
            length_ratio = shorter / longer if longer > 0 else 0
            if query_lower in cand_lower or cand_lower in query_lower:
                if length_ratio >= 0.5:
                    return 0.85
                # Low length ratio: substring match but too much extra text, penalize
                return 0.4
            # Bidirectional word overlap
            cand_words = set(cand_lower.replace(',', '').replace('.', '').split())
            # Remove common suffixes that add noise
            noise = {'llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'group', 'the'}
            clean_query = query_words - noise
            clean_cand = cand_words - noise
            if not clean_query or not clean_cand:
                return 0.0
            overlap = clean_query & clean_cand
            # Forward: what fraction of query words are in candidate?
            forward = len(overlap) / len(clean_query)
            # Reverse: what fraction of candidate words are in query?
            reverse = len(overlap) / len(clean_cand)
            # Use the minimum to penalize when candidate has many extra words
            return min(forward, reverse)

        # Filter: require at least 60% bidirectional word overlap to be considered a match
        MIN_SIMILARITY = 0.6
        viable = [p for p in pool if name_similarity(p["name"]) >= MIN_SIMILARITY]

        if not viable:
            # No good name match found despite having suggestions
            result["found"] = False
            return result

        best = None
        for preferred_country in ["US", "GB", "IN", "AE"]:
            matches = [p for p in viable if p["country"] == preferred_country]
            if matches:
                best = sorted(matches, key=lambda x: x["ad_count"], reverse=True)[0]
                break

        if not best:
            best = sorted(viable, key=lambda x: x["ad_count"], reverse=True)[0]

        result["found"] = True
        result["best_match"] = best

    except ImportError:
        result["error"] = "GoogleAds library not installed. Run: pip install Google-Ads-Transparency-Scraper"
    except Exception as e:
        result["error"] = str(e)

    return result

if __name__ == "__main__":
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    if query:
        data = search_competitor(query)
        print("RESPONDIQ_JSON:" + json.dumps(data))
    else:
        print("RESPONDIQ_JSON:" + json.dumps({"error": "No query provided", "found": False}))
`;

// ── Ensure the Python script file exists ──
let scriptPath = null;

function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  scriptPath = path.join(__dirname, '_google_transparency_scraper.py');
  fs.writeFileSync(scriptPath, PYTHON_SCRIPT);
  return scriptPath;
}

// ── Check if Python + GoogleAds library is available ──
let pythonAvailable = null;

function checkPythonSetup() {
  if (pythonAvailable !== null) return pythonAvailable;
  try {
    execSync('python3 -c "from GoogleAds import GoogleAds; print(True)"', {
      timeout: 10000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    pythonAvailable = true;
    console.log('[RespondIQ] Competitive Intel: Python + GoogleAds library available');
  } catch (e) {
    pythonAvailable = false;
    console.warn('[RespondIQ] Competitive Intel: Python GoogleAds library NOT available. Install with: pip install Google-Ads-Transparency-Scraper');
  }
  return pythonAvailable;
}

// ══════════════════════════════════════════════════════════════
// Core: Call Python scraper for a single competitor
// ══════════════════════════════════════════════════════════════
function scrapeOneCompetitor(query) {
  const script = ensureScript();
  try {
    const output = execSync(
      `python3 "${script}" "${query.replace(/"/g, '\\"')}"`,
      { timeout: 20000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Find our JSON marker in the output (Python lib may print junk before it)
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.startsWith('RESPONDIQ_JSON:')) {
        return JSON.parse(line.substring('RESPONDIQ_JSON:'.length));
      }
    }

    return { query, found: false, error: 'No JSON marker in Python output' };
  } catch (error) {
    return { query, found: false, error: error.message?.substring(0, 200) || 'Python execution failed' };
  }
}

// ══════════════════════════════════════════════════════════════
// Main: Get competitive intelligence for multiple competitors
// ══════════════════════════════════════════════════════════════
async function getCompetitiveIntelligence(competitorNames) {
  if (!competitorNames || competitorNames.length === 0) return [];

  // Check if Python setup is available
  if (!checkPythonSetup()) {
    console.warn('[RespondIQ] Skipping competitive intel (Python not configured)');
    return competitorNames.map(name => ({
      query: name.trim(),
      found: false,
      reason: 'Python GoogleAds library not installed on server',
    }));
  }

  const results = [];

  for (const name of competitorNames) {
    const cleaned = name.trim();
    if (!cleaned) continue;

    // Remove domain suffixes for cleaner search
    const searchQuery = cleaned
      .replace(/\.(com|co\.uk|io|net|org|ai)$/i, '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '');

    // Check cache
    const cacheKey = 'ci:' + searchQuery.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push(cached.data);
      continue;
    }

    // Call Python scraper
    console.log('[RespondIQ] Querying Google Ads Transparency for:', searchQuery);
    const raw = scrapeOneCompetitor(searchQuery);

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

    // Rate limit between Python calls
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
