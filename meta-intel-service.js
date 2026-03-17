// ══════════════════════════════════════════════════════════════
// meta-intel-service.js
// Meta Ad Library - FREE Competitive Intelligence
// Uses Python + Playwright to scrape Meta's public Ad Library
// Zero cost, no API keys required
// ══════════════════════════════════════════════════════════════

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── In-memory cache (ad library data is stable within a day) ──
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// ── Python scraper script (embedded, auto-written to disk on first call) ──
const PYTHON_SCRIPT = `
import sys
import json
import re

def search_meta_ads(query):
    """
    Search Meta Ad Library for a company's active ads.
    Uses Playwright to load the page and extract ad count from GraphQL responses.
    Falls back to HTML parsing if GraphQL intercept fails.
    """
    result = {
        "query": query,
        "found": False,
        "ad_count": 0,
        "page_name": None,
        "page_id": None,
        "platforms": [],
        "ad_library_url": None
    }

    try:
        from playwright.sync_api import sync_playwright

        search_url = (
            "https://www.facebook.com/ads/library/"
            "?active_status=active"
            "&ad_type=all"
            "&country=ALL"
            "&media_type=all"
            "&search_type=keyword_unordered"
            "&q=" + query.replace(" ", "+")
        )
        result["ad_library_url"] = search_url

        graphql_data = []

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 720}
            )
            page = context.new_page()

            # Intercept responses to catch GraphQL ad data
            def handle_response(response):
                try:
                    if "graphql" in response.url and response.status == 200:
                        body = response.text()
                        if "ad_library" in body or "ads_count" in body or "page_name" in body:
                            graphql_data.append(body)
                except:
                    pass

            page.on("response", handle_response)

            # Navigate and wait for content
            page.goto(search_url, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(3000)  # Extra wait for GraphQL to complete

            # Method 1: Try to extract from intercepted GraphQL
            for gql in graphql_data:
                try:
                    # Look for ad count patterns in GraphQL response
                    count_match = re.search(r'"ads_count"\\s*:\\s*(\\d+)', gql)
                    if count_match:
                        result["ad_count"] = int(count_match.group(1))
                        result["found"] = True

                    name_match = re.search(r'"page_name"\\s*:\\s*"([^"]+)"', gql)
                    if name_match:
                        result["page_name"] = name_match.group(1)

                    id_match = re.search(r'"page_id"\\s*:\\s*"(\\d+)"', gql)
                    if id_match:
                        result["page_id"] = id_match.group(1)
                except:
                    continue

            # Method 2: Fallback to DOM parsing
            if not result["found"]:
                try:
                    # Meta Ad Library shows "X results" or "About X results" text
                    content = page.content()

                    # Pattern: "X results" in the page
                    results_match = re.search(r'(\\d[\\d,]*)\\s+results?', content)
                    if results_match:
                        count_str = results_match.group(1).replace(",", "")
                        result["ad_count"] = int(count_str)
                        result["found"] = True

                    # Pattern: Look for advertiser count in aria labels or text
                    if not result["found"]:
                        aria_match = re.search(r'aria-label="[^"]*?(\\d+)\\s+ads?[^"]*?"', content)
                        if aria_match:
                            result["ad_count"] = int(aria_match.group(1))
                            result["found"] = True

                    # Try to find page name from any ad card on the page
                    if not result["page_name"]:
                        # Look for the first advertiser name in results
                        page_match = re.search(r'"pageName"\\s*:\\s*"([^"]+)"', content)
                        if page_match:
                            result["page_name"] = page_match.group(1)
                except:
                    pass

            # Method 3: Check if we see "no results" indicators
            if not result["found"]:
                try:
                    content = page.content()
                    if "didn't find any results" in content.lower() or "no results" in content.lower():
                        result["found"] = False
                        result["ad_count"] = 0
                    elif "results" in content.lower():
                        # Page loaded but we couldn't parse the count, mark as found with 0
                        result["found"] = True
                        result["ad_count"] = 0
                except:
                    pass

            browser.close()

        # Determine platforms based on ad presence
        if result["found"] and result["ad_count"] > 0:
            result["platforms"] = ["Facebook"]
            if result["ad_count"] > 5:
                result["platforms"].append("Instagram")
            if result["ad_count"] > 20:
                result["platforms"].append("Audience Network")

    except ImportError:
        result["error"] = "Playwright not installed. Run: pip install playwright && playwright install chromium"
    except Exception as e:
        result["error"] = str(e)[:300]

    return result


if __name__ == "__main__":
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    if query:
        data = search_meta_ads(query)
        print("RESPONDIQ_META_JSON:" + json.dumps(data))
    else:
        print("RESPONDIQ_META_JSON:" + json.dumps({"error": "No query provided", "found": False}))
`;

// ── Ensure the Python script file exists ──
let scriptPath = null;

function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  scriptPath = path.join(__dirname, '_meta_ad_library_scraper.py');
  fs.writeFileSync(scriptPath, PYTHON_SCRIPT);
  return scriptPath;
}

// ── Check if Python + Playwright is available ──
let playwrightAvailable = null;

function checkPlaywrightSetup() {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    execSync('python3 -c "from playwright.sync_api import sync_playwright; print(True)"', {
      timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    });
    playwrightAvailable = true;
    console.log('[RespondIQ] Meta Ad Library: Python + Playwright available');
  } catch (e) {
    playwrightAvailable = false;
    console.warn('[RespondIQ] Meta Ad Library: Playwright NOT available. Install with: pip install playwright && playwright install chromium --with-deps');
  }
  return playwrightAvailable;
}

// ══════════════════════════════════════════════════════════════
// Core: Call Python scraper for a single competitor
// ══════════════════════════════════════════════════════════════
function scrapeOneMetaAd(query) {
  const script = ensureScript();
  try {
    const output = execSync(
      `python3 "${script}" "${query.replace(/"/g, '\\"')}"`,
      { timeout: 45000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Find our JSON marker in the output
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.startsWith('RESPONDIQ_META_JSON:')) {
        return JSON.parse(line.substring('RESPONDIQ_META_JSON:'.length));
      }
    }

    return { query, found: false, error: 'No JSON marker in Python output' };
  } catch (error) {
    return { query, found: false, error: error.message?.substring(0, 200) || 'Python execution failed' };
  }
}

// ══════════════════════════════════════════════════════════════
// Main: Get Meta Ad Library data for multiple competitors
// ══════════════════════════════════════════════════════════════
async function getMetaAdIntelligence(competitorNames) {
  if (!competitorNames || competitorNames.length === 0) return [];

  // Check if Playwright is available
  if (!checkPlaywrightSetup()) {
    console.warn('[RespondIQ] Skipping Meta Ad Library intel (Playwright not configured)');
    return competitorNames.map(name => ({
      query: name.trim(),
      found: false,
      source: 'meta_ad_library',
      reason: 'Playwright not installed on server',
    }));
  }

  const results = [];

  for (const name of competitorNames) {
    const cleaned = name.trim();
    if (!cleaned) continue;

    // Check cache
    const cacheKey = 'meta:' + cleaned.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push(cached.data);
      continue;
    }

    // Call Python scraper
    console.log('[RespondIQ] Querying Meta Ad Library for:', cleaned);
    const raw = scrapeOneMetaAd(cleaned);

    let structured;
    if (raw.found && raw.ad_count > 0) {
      const adCount = raw.ad_count || 0;

      const activityLevel = adCount > 500 ? 'Very High' :
                            adCount > 100 ? 'High' :
                            adCount > 30 ? 'Moderate' :
                            adCount > 10 ? 'Active' :
                            adCount > 0 ? 'Low' : 'None Detected';

      structured = {
        query: cleaned,
        found: true,
        source: 'meta_ad_library',
        page_name: raw.page_name || cleaned,
        page_id: raw.page_id || null,
        ad_count: adCount,
        activity_level: activityLevel,
        platforms: raw.platforms || ['Facebook'],
        ad_library_url: raw.ad_library_url || `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(cleaned)}`,
      };
      console.log('[RespondIQ] Meta Ads Found:', raw.page_name || cleaned, '|', adCount, 'ads |', (raw.platforms || []).join(', '));
    } else if (raw.found && raw.ad_count === 0) {
      structured = {
        query: cleaned,
        found: true,
        source: 'meta_ad_library',
        ad_count: 0,
        activity_level: 'None Detected',
        platforms: [],
        ad_library_url: raw.ad_library_url,
      };
      console.log('[RespondIQ] Meta Ads: Page found but 0 active ads for:', cleaned);
    } else {
      structured = {
        query: cleaned,
        found: false,
        source: 'meta_ad_library',
        reason: raw.error || 'Not found in Meta Ad Library',
      };
      console.log('[RespondIQ] Meta Ads Not found:', cleaned, '|', raw.error || 'no results');
    }

    cache.set(cacheKey, { data: structured, timestamp: Date.now() });
    results.push(structured);

    // Rate limit between Playwright calls (browser is heavy)
    if (competitorNames.indexOf(name) < competitorNames.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════════
// Build the prompt injection block for Meta data
// ══════════════════════════════════════════════════════════════
function buildMetaPromptBlock(results) {
  if (!results || results.length === 0) return '';

  const found = results.filter(r => r.found && r.ad_count > 0);
  if (found.length === 0) return '';

  let block = '\nRULE 17 — META AD LIBRARY INTELLIGENCE (from Meta Ad Library, public data):\n';
  block += 'The following competitor data was retrieved from Meta\'s public Ad Library. Use these VERIFIED data points for Meta/Facebook/Instagram channels.\n\n';

  for (const comp of found) {
    block += `VERIFIED (Meta): ${comp.page_name || comp.query}\n`;
    block += `- Active Meta ads: ${comp.ad_count}\n`;
    block += `- Activity level: ${comp.activity_level}\n`;
    block += `- Platforms: ${comp.platforms.join(', ')}\n`;
    block += `- Source: ${comp.ad_library_url}\n\n`;
  }

  const notFound = results.filter(r => !r.found || r.ad_count === 0);
  if (notFound.length > 0) {
    block += `NOT FOUND or INACTIVE on Meta: ${notFound.map(n => n.query).join(', ')}. These competitors may not advertise on Meta platforms.\n\n`;
  }

  block += 'INSTRUCTIONS:\n';
  block += '- Reference verified Meta ad counts in competitive_sov when discussing Facebook/Instagram channels\n';
  block += '- High activity on Meta suggests social/display-heavy strategy\n';
  block += '- Label Meta data as "verified via Meta Ad Library"\n';

  return block;
}

module.exports = {
  getMetaAdIntelligence,
  buildMetaPromptBlock,
};
