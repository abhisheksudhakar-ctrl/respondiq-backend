// ═══════════════════════════════════════════════════════════════
// RespondIQ v12.6 — Gemini 3.1 Pro + Medium Thinking + Search Grounding
// + Server-Side Prompts + SSRF Protection
// AI Model: gemini-3.1-pro-preview (thinking_level: MEDIUM)
// Hosted on: Render.com (Web Service)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const { getKeywordIdeas, isKeywordServiceConfigured } = require('./keyword-service');
const { getCompetitiveIntelligence, buildCompetitorPromptBlock } = require('./competitive-intel-service');
const { getMetaAdsIntelligence, buildMetaAdsPromptBlock } = require('./meta-ads-service');
const { BENCHMARKS, BENCHMARK_SOURCES, resolveIndustryKey, buildBenchmarkPromptBlock, refreshBenchmarksFromWeb, getBenchmarkMeta } = require('./benchmark-data');

const app = express();
const PORT = process.env.PORT || 10000;

// ── Strict CORS: Only allow requests from your frontend ──
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://respondiq-jidy.onrender.com',
  'http://localhost:3000',
  'http://localhost:8765',
  'http://127.0.0.1:8765'
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const clean = origin.replace(/\/$/, '');
    if (ALLOWED_ORIGINS.some(o => o.replace(/\/$/, '') === clean)) {
      return callback(null, true);
    }
    console.warn('[RespondIQ] CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ── Gemini Client Init ──
function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in Render environment variables');
  return new GoogleGenAI({ apiKey: key });
}

// ══════════════════════════════════════════════════════════════
// LLM RESPONSE PARSER: Extracts JSON from Gemini responses
// Handles markdown fences, preamble text, and partial responses
// ══════════════════════════════════════════════════════════════
function extractJSONFromLLM(raw, expectedType) {
  if (!raw || typeof raw !== 'string') return null;

  // Step 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
  let text = raw.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();

  // Step 2: Strip any preamble text before the first { or [
  // Handles "Here is the JSON requested:" and similar conversational wrappers
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (expectedType === 'object' && firstBrace > 0) {
    text = text.substring(firstBrace);
  } else if (expectedType === 'array' && firstBracket > 0) {
    text = text.substring(firstBracket);
  } else if (!expectedType) {
    const earliest = firstBrace >= 0 && firstBracket >= 0
      ? Math.min(firstBrace, firstBracket)
      : Math.max(firstBrace, firstBracket);
    if (earliest > 0) text = text.substring(earliest);
  }

  // Step 3: Sanitize unescaped control characters inside JSON string values.
  // Gemini frequently returns literal newlines/tabs inside JSON strings
  // which breaks JSON.parse(). This escapes them properly.
  text = sanitizeJSONControlChars(text);

  // Step 4: Try direct parse (cleanest path)
  try {
    const parsed = JSON.parse(text);
    if (expectedType === 'array' && Array.isArray(parsed)) return parsed;
    if (expectedType === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (!expectedType) return parsed;
  } catch (e) { /* direct parse failed, try extraction */ }

  // Step 5: Brace/bracket-counting extraction for the outermost structure
  const opener = expectedType === 'array' ? '[' : '{';
  const closer = expectedType === 'array' ? ']' : '}';
  const startIdx = text.indexOf(opener);
  if (startIdx === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.substring(startIdx, i + 1));
        } catch (e) { return null; }
      }
    }
  }
  return null;
}

/**
 * Sanitize unescaped control characters (newlines, tabs, etc.) inside JSON string values.
 * Walks the string character by character, tracking whether we're inside a quoted value,
 * and escapes any raw control characters (0x00-0x1F) that aren't already escaped.
 */
function sanitizeJSONControlChars(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    // If inside a JSON string and we hit a raw control character, escape it
    if (inString && code >= 0 && code <= 0x1F) {
      if (code === 0x0A)      result += '\\n';   // newline
      else if (code === 0x0D) result += '\\r';   // carriage return
      else if (code === 0x09) result += '\\t';   // tab
      else                    result += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    result += ch;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// PRIORITY 1: SSRF VALIDATION
// Rejects private IPs, metadata endpoints, non-standard ports
// ══════════════════════════════════════════════════════════════
const { URL } = require('url');
const dns = require('dns');
const { promisify } = require('util');
const dnsLookup = promisify(dns.lookup);

function isPrivateIP(ip) {
  const normalized = String(ip || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIP(normalized.replace('::ffff:', ''));
  }

  // IPv4 private/reserved ranges
  if (/^0\./.test(normalized)) return true;
  if (/^10\./.test(normalized)) return true;                       // Class A private
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized)) return true; // CGNAT
  if (/^127\./.test(normalized)) return true;                      // loopback
  if (/^169\.254\./.test(normalized)) return true;                 // link-local / metadata
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;  // Class B private
  if (/^192\.168\./.test(normalized)) return true;                 // Class C private
  if (/^192\.0\.0\./.test(normalized)) return true;
  if (/^192\.0\.2\./.test(normalized)) return true;                // documentation
  if (/^198\.(1[89])\./.test(normalized)) return true;             // benchmarking
  if (/^198\.51\.100\./.test(normalized)) return true;             // documentation
  if (/^203\.0\.113\./.test(normalized)) return true;              // documentation
  if (/^(22[4-9]|23\d|24\d|25[0-5])\./.test(normalized)) return true; // multicast/reserved
  if (normalized === '0.0.0.0') return true;

  // IPv6 private/reserved ranges
  if (normalized === '::1' || normalized === '::') return true;     // loopback/unspecified
  if (/^(fc|fd)/.test(normalized)) return true;                    // unique local
  if (/^fe80/.test(normalized)) return true;                       // link-local
  if (/^ff/.test(normalized)) return true;                         // multicast
  if (/^2001:db8/.test(normalized)) return true;                   // documentation
  return false;
}

async function validateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol check: only http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http and https protocols are allowed' };
  }

  // Reject non-standard ports
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { valid: false, reason: 'Non-standard ports are not allowed' };
  }

  // Reject obvious private hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]') {
    return { valid: false, reason: 'Requests to localhost/loopback are not allowed' };
  }

  // DNS resolution check: reject if any resolved address is private/reserved.
  try {
    const records = await dnsLookup(parsed.hostname, { all: true });
    if (records.some(record => isPrivateIP(record.address))) {
      return { valid: false, reason: 'URL resolves to a private/reserved IP range' };
    }
  } catch {
    return { valid: false, reason: 'Could not resolve hostname' };
  }

  return { valid: true, url: parsed.href };
}


// ══════════════════════════════════════════════════════════════
// PRIORITY 2: SERVER-SIDE PROMPT BUILDER
// All proprietary rules and logic assembled here, not on the client
// ══════════════════════════════════════════════════════════════

const BUDGET_MAP = {
  '$1,000 - $5,000': { low: 1000, high: 5000, mid: 3000 },
  '$5,000 - $10,000': { low: 5000, high: 10000, mid: 7500 },
  '$10,000 - $25,000': { low: 10000, high: 25000, mid: 17500 },
  '$25,000 - $50,000': { low: 25000, high: 50000, mid: 37500 },
  '$50,000 - $100,000': { low: 50000, high: 100000, mid: 75000 },
  '$100,000 - $250,000': { low: 100000, high: 250000, mid: 175000 },
  '$250,000 - $500,000': { low: 250000, high: 500000, mid: 375000 },
  '$500,000 - $1,000,000': { low: 500000, high: 1000000, mid: 750000 },
  '$1,000,000+': { low: 1000000, high: 2000000, mid: 1500000 }
};

const DURATION_MONTHS = {
  '4 Weeks': 1, '8 Weeks': 2, '12 Weeks (Quarter)': 3, '6 Months': 6, '12 Months (Annual)': 12
};

const FUNNEL_GUIDE = {
  'Sales & Conversions': 'Funnel split: 20% awareness, 30% consideration, 50% conversion. Heavy on search, retargeting, shopping ads. Optimize for ROAS and CPA.',
  'Leads & Signups': 'Funnel split: 25% awareness, 40% consideration, 35% conversion. Focus on lead gen forms, landing pages, search + social lead ads. Optimize for CPL.',
  'Brand Awareness': 'Funnel split: 60% awareness, 30% consideration, 10% conversion. Heavy on video, CTV, display, social reach campaigns. Optimize for reach, frequency, brand lift.',
  'Website Traffic': 'Funnel split: 30% awareness, 45% consideration, 25% conversion. Focus on search, social clicks, native, display. Optimize for CPC and session quality.',
  'App Installs': 'Funnel split: 25% awareness, 35% consideration, 40% conversion. Focus on mobile-first channels, app install campaigns, deep linking. Optimize for CPI.',
  'Store Visits / Foot Traffic': 'Funnel split: 35% awareness, 35% consideration, 30% conversion. Focus on local search, geo-targeted display, DOOH, social with store visit optimization. Optimize for cost per store visit.',
  'Product Launch': 'Funnel split: 50% awareness, 35% consideration, 15% conversion. Phase 1 (teaser/hype), Phase 2 (launch blitz), Phase 3 (sustain). Heavy video + social + PR.',
  'Market Expansion': 'Funnel split: 45% awareness, 35% consideration, 20% conversion. Focus on new geo/demo targeting, brand building in new markets, competitive conquest.',
  'Customer Retention': 'Funnel split: 15% awareness, 25% consideration, 60% conversion. Focus on email, retargeting, loyalty programs, CRM-based audiences. Optimize for LTV and churn rate.',
  'Event Promotion': 'Funnel split: 40% awareness, 40% consideration, 20% conversion. Time-sensitive, heavy first 60% of timeline, countdown urgency. Focus on social, search, email, geo-targeted.'
};

function normalizeActivityTier(value, count) {
  const text = String(value || '').toLowerCase();
  const n = Number(count || 0);
  if (/very high|high/.test(text) || n > 100) return 'High';
  if (/moderate|medium|active/.test(text) || n > 20) return 'Medium';
  if (/low/.test(text) || n > 0) return 'Low';
  return 'Nil';
}

function activityLabel(tier) {
  return tier === 'Nil' ? 'Nil ad activity' : tier + ' ad activity';
}

function activityScore(tier) {
  if (tier === 'High') return 3;
  if (tier === 'Medium') return 2;
  if (tier === 'Low') return 1;
  return 0;
}

function benchmarkKeyForIndustry(industry) {
  const raw = String(industry || '').toLowerCase();
  if (!raw) return null;
  const resolved = resolveIndustryKey(raw);
  if (resolved && resolved !== 'default') return resolved;
  for (const [key, val] of Object.entries(BENCHMARKS)) {
    if (raw.includes(key.replace(/_/g, ' ')) || raw.includes(String(val.label || '').toLowerCase())) return key;
  }
  if (/e.?commerce|retail|dtc|shop/.test(raw)) return 'ecommerce';
  if (/legal|law/.test(raw)) return 'legal';
  if (/real estate|property/.test(raw)) return 'real_estate';
  if (/dental|dentist|orthodont/.test(raw)) return 'dental';
  if (/health|medical|clinic/.test(raw)) return 'healthcare';
  if (/finance|financial|insurance|bank/.test(raw)) return 'finance';
  if (/b2b|saas|software|technology|tech/.test(raw)) return 'b2b_saas';
  if (/education|school|university/.test(raw)) return 'education';
  if (/home|local service|contractor/.test(raw)) return 'home_services';
  if (/travel|hotel|hospitality/.test(raw)) return 'travel';
  if (/automotive|auto|car/.test(raw)) return 'automotive';
  if (/restaurant|food/.test(raw)) return 'restaurant';
  if (/fitness|wellness/.test(raw)) return 'fitness';
  if (/non.?profit|charity/.test(raw)) return 'nonprofit';
  return null;
}

function benchmarkChannelForPlatform(platform) {
  const p = String(platform || '').toLowerCase();
  if (/search|google ads/.test(p)) return 'google_search';
  if (/display|gdn/.test(p)) return 'google_display';
  if (/instagram/.test(p)) return 'instagram';
  if (/facebook|meta/.test(p)) return 'meta';
  if (/linkedin/.test(p)) return 'linkedin';
  if (/tiktok/.test(p)) return 'tiktok';
  if (/youtube/.test(p)) return 'youtube';
  if (/programmatic|native|display/.test(p)) return 'programmatic';
  return null;
}

function averageBenchmarkMetric(industry, platform, metric) {
  const key = benchmarkKeyForIndustry(industry);
  const data = key ? BENCHMARKS[key] : null;
  if (!data || !data.channels) return null;
  const requested = String(platform || '').split(',').map(benchmarkChannelForPlatform).filter(Boolean);
  const channels = requested.length ? requested : Object.keys(data.channels);
  const values = channels
    .map(ch => data.channels[ch] && data.channels[ch][metric])
    .filter(v => Number.isFinite(Number(v)) && Number(v) > 0)
    .map(Number);
  if (!values.length) return null;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

function parseHistoricalPerformance(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = text.match(/CPA\s+under\s+\$?([\d.]+)/i);
  if (match) return { metric: 'CPA', label: 'Avg CPA under $' + match[1], high: Number(match[1]), bucket: text };
  match = text.match(/CPA\s+\$?([\d.]+)\s*-\s*\$?([\d.]+)/i);
  if (match) return { metric: 'CPA', label: 'Avg CPA $' + match[1] + '-$' + match[2], low: Number(match[1]), high: Number(match[2]), bucket: text };
  match = text.match(/CPA\s+over\s+\$?([\d.]+)/i);
  if (match) return { metric: 'CPA', label: 'Avg CPA over $' + match[1], low: Number(match[1]), bucket: text };
  match = text.match(/ROAS\s+([\d.]+):1\s*-\s*([\d.]+):1/i);
  if (match) return { metric: 'ROAS', label: 'ROAS ' + match[1] + ':1-' + match[2] + ':1', low: Number(match[1]), high: Number(match[2]), bucket: text };
  match = text.match(/ROAS\s+([\d.]+):1\+/i);
  if (match) return { metric: 'ROAS', label: 'ROAS ' + match[1] + ':1+', low: Number(match[1]), bucket: text };
  return { metric: 'Other', label: text, bucket: text };
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 100) return Math.round(n / 5) * 5;
  return Math.round(n);
}

function buildCompetitivePressureSignal(googleResults, metaResults) {
  const rows = [];
  (Array.isArray(googleResults) ? googleResults : []).forEach(r => {
    if (!r || !r.found) return;
    const tier = normalizeActivityTier(r.google_activity_tier || r.activity_level, r.ad_count || r.account_ad_count || r.raw_ad_count);
    rows.push({ source: 'Google Ads Transparency Center', brand: r.name || r.query, tier, score: activityScore(tier) });
  });
  (Array.isArray(metaResults) ? metaResults : []).forEach(r => {
    if (!r || !r.found) return;
    const tier = normalizeActivityTier(r.activity_level, r.ad_count);
    rows.push({ source: 'Meta Ad Library', brand: r.page_name || r.query, tier, score: activityScore(tier) });
  });

  const totalScore = rows.reduce((sum, row) => sum + row.score, 0);
  let level = 'Nil';
  if (totalScore >= 8 || rows.filter(r => r.tier === 'High').length >= 2) level = 'High';
  else if (totalScore >= 4 || rows.some(r => r.tier === 'High')) level = 'Medium';
  else if (totalScore > 0) level = 'Low';

  const rateAdjustmentPct = level === 'High' ? 15 : level === 'Medium' ? 8 : level === 'Low' ? 3 : 0;
  return {
    level,
    label: activityLabel(level),
    rate_adjustment_pct: rateAdjustmentPct,
    verified_sources: rows.length,
    high_activity_competitors: rows.filter(r => r.tier === 'High').length,
    summary: rows.length
      ? `${activityLabel(level)} across ${rows.length} verified source match${rows.length === 1 ? '' : 'es'}; model CPC/CPM sensitivity at +${rateAdjustmentPct}%.`
      : 'No verified active ad-library signal found; do not claim competitor inactivity unless a source explicitly reports zero active ads.',
    rows
  };
}

function buildCampaignCalibrationSignal(data, pressure) {
  const historical = parseHistoricalPerformance(data.pastPerformance);
  if (!historical) return null;
  const pressureMultiplier = 1 + ((pressure && pressure.rate_adjustment_pct) || 0) / 100;

  if (historical.metric === 'CPA') {
    const benchmarkCpa = averageBenchmarkMetric(data.industry, data.platform, 'cpa');
    const adjustedBenchmark = benchmarkCpa ? benchmarkCpa * pressureMultiplier : null;
    let target = null;
    let beatSupported = false;
    let logic = '';

    if (historical.high) {
      beatSupported = !!adjustedBenchmark && adjustedBenchmark <= historical.high * 0.9;
      if (beatSupported) {
        target = roundMoney(Math.min(adjustedBenchmark * 0.98, historical.high * 0.92));
        logic = `Reported performance is treated as a blended business-level baseline; paid-media benchmarks support a precise modeled launch target of $${target}.`;
      } else {
        target = roundMoney(adjustedBenchmark || historical.high);
        logic = `Reported performance is treated as a blended historical baseline; paid-media benchmarks support a precise modeled launch target of $${target}.`;
      }
    } else if (historical.low) {
      target = roundMoney(adjustedBenchmark || historical.low * 0.85);
      beatSupported = !!adjustedBenchmark && adjustedBenchmark < historical.low;
      logic = `Historical CPA is used as a blended baseline; the plan models a launch target of $${target} and frames it as an improvement path.`;
    }

    return {
      metric: 'CPA',
      reported_label: historical.label,
      reported_bucket: historical.bucket,
      benchmark_reference: adjustedBenchmark ? '$' + roundMoney(adjustedBenchmark) : 'industry benchmark unavailable',
      modeled_target: target ? '$' + target : '',
      modeled_target_value: target,
      beat_supported: beatSupported,
      logic
    };
  }

  if (historical.metric === 'ROAS') {
    const benchmarkRoas = averageBenchmarkMetric(data.industry, data.platform, 'roas') || null;
    let target = benchmarkRoas || (historical.high ? (historical.low + historical.high) / 2 : historical.low || 3);
    let beatSupported = false;
    if (historical.high && benchmarkRoas && benchmarkRoas > historical.high * 1.1) {
      beatSupported = true;
      target = benchmarkRoas;
    } else if (historical.high) {
      target = Math.min(target, historical.high);
    }
    target = Math.round(target * 10) / 10;
    return {
      metric: 'ROAS',
      reported_label: historical.label,
      reported_bucket: historical.bucket,
      benchmark_reference: benchmarkRoas ? benchmarkRoas.toFixed(1) + ':1' : 'industry benchmark unavailable',
      modeled_target: target.toFixed(1) + ':1',
      modeled_target_value: target,
      beat_supported: beatSupported,
      logic: beatSupported
        ? `Benchmarks support a precise ROAS target above the reported range: ${target.toFixed(1)}:1.`
        : `The reported ROAS range is treated as historical context; the plan uses ${target.toFixed(1)}:1 as the modeled target.`
    };
  }

  return {
    metric: historical.metric,
    reported_label: historical.label,
    reported_bucket: historical.bucket,
    logic: 'Reported performance is used as historical context and calibrated against benchmarks before setting plan targets.'
  };
}

function buildPlanningSignals(data, googleResults, metaResults) {
  const competitivePressure = buildCompetitivePressureSignal(googleResults, metaResults);
  const campaignCalibration = buildCampaignCalibrationSignal(data, competitivePressure);
  if (!campaignCalibration && competitivePressure.level === 'Nil' && !data.webTraffic && !data.salesCycle && !data.crmTool && !data.creativeAssets) {
    return null;
  }
  return {
    campaign_calibration: campaignCalibration,
    competitive_pressure: competitivePressure,
    website_traffic_signal: data.webTraffic || '',
    sales_cycle_signal: data.salesCycle || '',
    crm_signal: data.crmTool || '',
    creative_signal: data.creativeAssets || ''
  };
}

function buildPlanningSignalsPromptBlock(signals) {
  if (!signals) return '';
  const calibration = signals.campaign_calibration;
  const pressure = signals.competitive_pressure;
  let block = '\nRULE 20 — CAMPAIGN INTELLIGENCE CALIBRATION + COMPETITIVE PRESSURE:\n';
  block += 'Use the structured planning signals below to shape strategy, benchmarks, KPIs, recommendations, risks, and narrative. These are not decorative data points.\n';
  if (calibration) {
    block += `- Reported historical baseline: ${calibration.reported_label}. Treat this as broad business-level context unless the user says it is platform-specific.\n`;
    if (calibration.modeled_target) {
      block += `- Required precise modeled target: ${calibration.modeled_target} ${calibration.metric}. Use this client-facing target instead of repeating the reported bucket "${calibration.reported_bucket}".\n`;
      block += `- Beat historical only when benchmark-supported: ${calibration.beat_supported ? 'yes' : 'no'}. ${calibration.logic}\n`;
      block += '- Include a visible "Reported Historical Baseline" note in objectives or recommendations explaining how the plan target was calibrated.\n';
    }
  }
  if (pressure) {
    block += `- Competitive pressure: ${pressure.label}. Verified source matches: ${pressure.verified_sources}. CPC/CPM sensitivity adjustment: +${pressure.rate_adjustment_pct}%.\n`;
    block += '- Show this as a visible planning signal in the plan. Use it to explain rate pressure, share-of-voice risk, conquesting difficulty, and monitoring needs.\n';
    block += '- Client-facing competitor activity should use only these tiers: High ad activity, Medium ad activity, Low ad activity, or Nil ad activity.\n';
  }
  block += 'Client-facing KPI values should be precise, such as "$18 CPA" or "$26 CPA", rather than broad historical buckets such as "under $20 CPA".\n';
  return block;
}

function buildSystemPrompt(data) {
  return `You are a senior media planner at a top agency preparing a real client deliverable. You must return ONLY valid JSON, no markdown, no code fences, no explanation text.

ABSOLUTE RULES YOU CANNOT BREAK:
1. Every competitor must be a REAL brand that is a genuine competitive peer, matched by service type, company scale, and target market. NEVER pick giant corporations unless the client is also a giant corporation. NEVER use placeholders like "Competitor A" or "Brand X".
2. Every CPM/CPC must be a specific dollar amount (never "Varies" or "Projected")
3. Every impression number must be calculated from (budget / CPM * 1000)
4. All budget percentages must sum to exactly 100%
5. The total of all channel impressions must approximately equal projected_impressions
6. Flight plan entries must describe real tactical actions, not symbols or dots
7. Channel tactics must be specific and actionable, not generic
8. KPI targets must be realistic numbers based on industry benchmarks for ${data.industry}
9. If website content is provided, READ IT CAREFULLY to understand what the business actually does before selecting competitors. The website content is the #1 source of truth for competitor matching.
10. For every CPM, CPC, CTR, and industry benchmark figure, you MUST use your search capability to look up current rates before writing any number. Search for "[industry] average CPM 2025", "[channel] advertising benchmark [industry] 2025", "average CPC [channel] [industry]", and equivalent queries. Use ONLY search-verified rates, never use memorised training data for cost figures. If search returns a range, use the midpoint. Every benchmark in the benchmarks array must reference a figure you verified via search, not estimated from memory.
11. Never show exact competitor ad counts in the plan. Use only High ad activity, Medium ad activity, Low ad activity, or Nil ad activity.`;
}

function buildUserPrompt(data, bInfo, months, totalBudgetLow, totalBudgetHigh, totalBudgetMid, keywordData, competitorIntelBlock) {
  const funnelAdvice = FUNNEL_GUIDE[data.goal] || FUNNEL_GUIDE['Sales & Conversions'];

  // ── Channel count cap: if >12 channels selected, instruct AI to consolidate ──
  const MAX_PRIMARY_CHANNELS = 12;
  const channelList = (data.platform || '').split(',').map(c => c.trim()).filter(Boolean);
  const channelCount = channelList.length;
  let channelCapInstruction = '';
  if (channelCount > MAX_PRIMARY_CHANNELS) {
    channelCapInstruction = `\nCHANNEL CONSOLIDATION REQUIRED: The user selected ${channelCount} channels, which is too many to allocate meaningful budget to. You MUST:
1. Select the TOP ${MAX_PRIMARY_CHANNELS} most impactful channels for the "${data.goal}" goal in the ${data.industry} industry.
2. Allocate budget ONLY to those ${MAX_PRIMARY_CHANNELS} channels (plus a Contingency line).
3. In the media_strategy section, briefly note which channels were deprioritized and why.
4. Do NOT spread budget equally across all ${channelCount} channels at 1% each, that creates zero impact. Concentrate spend where it drives results.
5. Weight the top channels using goal-appropriate allocation (e.g., for Sales & Conversions: 25-30% search, 20% social, 15% retargeting, etc.).`;
  }

  const competitorInstruction = data.competitors
    ? `The client has identified these key competitors: ${data.competitors}. Use these EXACT competitor names in your analysis. For each competitor, describe their actual known advertising approach, what platforms they advertise on, their messaging themes, their estimated market share, and their competitive strengths. Research what their ads look like on Google Ads Transparency Center, Meta Ad Library, and LinkedIn Ads.`
    : `You MUST identify 3-5 REAL competitor brands that are ACTUAL competitive peers of ${data.brandName}. This is critical, follow these rules:

COMPETITOR MATCHING RULES:
1. MATCH BY SERVICE/PRODUCT TYPE: If ${data.brandName} offers specific services (e.g., ad operations, programmatic management), find competitors offering the SAME specific services, not just companies in the same broad industry.
2. MATCH BY COMPANY SCALE: ${data.brandName} is a ${data.companySize} company. Find competitors of SIMILAR size. Do NOT compare a small/mid-size company to Fortune 500 giants like Deloitte, Accenture, McKinsey, WPP, etc. unless ${data.brandName} is itself a large enterprise.
3. MATCH BY TARGET MARKET: Find competitors that go after the SAME types of clients/customers in the same regions.
4. MATCH BY COMPETITIVE OVERLAP: These should be companies that ${data.brandName} actually loses deals to, or competes against in RFPs and pitches.

EXAMPLES OF GOOD vs BAD matching:
- If brand is a small paid media agency: GOOD: MediaMint, Theorem, Jellyfish, Brainlabs. BAD: Accenture, Deloitte, WPP.
- If brand is a local bakery: GOOD: other local bakeries, regional chains. BAD: Hostess, Bimbo, Pillsbury.
- If brand is a mid-market SaaS: GOOD: similar-sized SaaS competitors. BAD: Salesforce, Oracle, SAP.

The website content (if provided below) will tell you EXACTLY what ${data.brandName} does. Use it to identify precise competitive peers. Every competitor must be a real, named company that actually exists.`;

  // Build the flight plan key instruction based on duration
  let flightKeyInstruction;
  if (months === 1) {
    flightKeyInstruction = `DURATION: 4 Weeks. Use WEEKLY keys.
    Each flight_plan object must have: "channel", "wk1", "wk2", "wk3", "wk4"
    Phase guidance: wk1 = "Launch", wk2 = "Optimize", wk3 = "Scale", wk4 = "Close"`;
  } else if (months === 2) {
    flightKeyInstruction = `DURATION: 8 Weeks. Use BI-WEEKLY keys.
    Each flight_plan object must have: "channel", "wk1_2", "wk3_4", "wk5_6", "wk7_8"`;
  } else if (months === 3) {
    flightKeyInstruction = `DURATION: 12 Weeks (Quarter). Use 3-WEEK keys.
    Each flight_plan object must have: "channel", "wk1_3", "wk4_6", "wk7_9", "wk10_12"`;
  } else if (months === 6) {
    flightKeyInstruction = `DURATION: 6 Months. Use CONSOLIDATED MONTHLY keys.
    Each flight_plan object must have: "channel", "month_1", "month_2_3", "month_4_5", "month_6"`;
  } else {
    flightKeyInstruction = `DURATION: 12 Months (Annual). Use QUARTERLY keys.
    Each flight_plan object must have: "channel", "q1", "q2", "q3", "q4"`;
  }

  // Build the flight plan JSON key template for the schema
  let flightPlanKeysTemplate;
  if (months === 1) flightPlanKeysTemplate = '"wk1":"Launch: specific actions","wk2":"Optimize: specific actions","wk3":"Scale: specific actions","wk4":"Close: specific actions"';
  else if (months === 2) flightPlanKeysTemplate = '"wk1_2":"Launch: specific actions","wk3_4":"Optimize: specific actions","wk5_6":"Scale: specific actions","wk7_8":"Close: specific actions"';
  else if (months === 3) flightPlanKeysTemplate = '"wk1_3":"Launch: specific actions","wk4_6":"Optimize: specific actions","wk7_9":"Scale: specific actions","wk10_12":"Close: specific actions"';
  else if (months === 6) flightPlanKeysTemplate = '"month_1":"Launch: specific actions","month_2_3":"Optimize: specific actions","month_4_5":"Scale: specific actions","month_6":"Close: specific actions"';
  else flightPlanKeysTemplate = '"q1":"Launch: setup, testing, initial campaigns","q2":"Optimize: refine targeting, creative refresh, scale winners","q3":"Scale: expand reach, new audiences, increase budget on top performers","q4":"Close: final push, retargeting, reporting, transition planning"';

  // Goal-specific KPI alignment
  let goalKpiBlock;
  if (data.goal === 'Leads & Signups') {
    goalKpiBlock = '- Do NOT show ROAS in the executive summary or KPI targets, leads-focused campaigns track CPL (Cost Per Lead), CPA, and Conversion Rate, not ROAS. ROAS requires revenue data which lead gen campaigns typically lack.\n- Focus KPIs on: CPL, form fill rate, lead quality score, lead-to-MQL conversion rate.';
  } else if (data.goal === 'Brand Awareness') {
    goalKpiBlock = '- Focus KPIs on: CPM, reach, frequency, brand lift, share of voice. Do NOT over-emphasize conversion metrics.\n- Budget should weight heavily toward upper-funnel channels.';
  } else if (data.goal === 'Website Traffic') {
    goalKpiBlock = '- Focus KPIs on: CPC, CTR, sessions, bounce rate, pages per session. Prioritize click-efficient channels.\n- Do NOT show ROAS unless the goal explicitly involves revenue.';
  } else if (data.goal === 'App Installs') {
    goalKpiBlock = '- Focus KPIs on: CPI (Cost Per Install), install rate, Day 1/7/30 retention. Prioritize mobile-first channels.';
  } else {
    goalKpiBlock = '- Align all KPI targets, channel selection, and budget allocation to the stated goal of ' + data.goal + '.';
  }

  // ROAS industry range for RULE 5
  let roasRange = '2:1 to 6:1';
  if (data.industry === 'E-commerce (DTC)' || data.industry === 'Retail') roasRange = '3:1 to 8:1';
  else if (data.industry === 'B2B SaaS') roasRange = '2:1 to 5:1';

  // Industry-specific CPC range for RULE 3
  let industryCpcRange = '2.00-4.50';
  if (data.industry === 'Financial Services' || data.industry === 'B2B SaaS') industryCpcRange = '4.00-8.00';
  else if (data.industry === 'E-commerce (DTC)' || data.industry === 'Retail') industryCpcRange = '1.20-3.00';

  let prompt = `You are a senior media strategist at a top-tier agency (like GroupM, Dentsu, or Publicis) preparing a real client media plan. This plan will be presented to the client. Every number must be realistic, defensible, and based on current industry data.

=== CLIENT BRIEF ===
Brand: ${data.brandName}
Website: ${data.website}
Industry: ${data.industry}
Company Size: ${data.companySize}
Campaign: ${data.campaignName}
Duration: ${data.campaignDuration} (${months} months)
Monthly Budget: ${data.budget} (range: $${bInfo.low.toLocaleString()}-$${bInfo.high.toLocaleString()}/mo)
Total Campaign Budget: $${totalBudgetLow.toLocaleString()} - $${totalBudgetHigh.toLocaleString()} (use ~$${totalBudgetMid.toLocaleString()} as working number)
Goal: ${data.goal}
Primary KPI: ${data.kpi}
Target Location: ${data.location}${data.locationList && data.locationList.length > 1 ? ' (multi-geo campaign targeting ' + data.locationList.length + ' markets: ' + data.locationList.join(', ') + ')' : ''}
Target Age: ${data.ageRange}
Target Gender: ${data.gender}
Household Income: ${data.income}
Selected Channels: ${data.platform}${channelCapInstruction}
Creative Formats: ${data.creativeFormat}
Known Competitors: ${data.competitors || 'Not specified, you must identify them based on the brand, website, industry, and company size'}
${data.pastPerformance ? 'Past Campaign Performance: ' + data.pastPerformance : ''}
${data.salesCycle ? 'Average Sales Cycle: ' + data.salesCycle : ''}
${data.webTraffic ? 'Current Website Traffic: ' + data.webTraffic : ''}
${data.crmTool ? 'CRM / Marketing Stack: ' + data.crmTool : ''}
${data.creativeAssets ? 'Available Creative Assets: ' + data.creativeAssets : ''}
Additional Context: ${data.notes || 'None'}

CRITICAL CONTEXT FOR COMPETITOR IDENTIFICATION:
- ${data.brandName} is a ${data.companySize} in the ${data.industry} space
- Their website is ${data.website}, VISIT THIS MENTALLY to understand what they actually do
- With a monthly ad budget of ${data.budget}, this suggests they are a ${bInfo.mid < 10000 ? 'small/emerging' : bInfo.mid < 50000 ? 'mid-market' : bInfo.mid < 250000 ? 'established mid-market' : 'large'} player
- Competitors MUST be companies of similar scale that compete for the same customers
- Do NOT default to Fortune 500 / Big 4 / household-name companies unless the brand itself is that size
- Think: "Who would ${data.brandName} encounter in a competitive pitch or lose a deal to?"
${data.salesCycle ? `\n=== CAMPAIGN INTELLIGENCE ===\nSales Cycle: ${data.salesCycle} - ${data.salesCycle === 'Same day' || data.salesCycle === '1-7 days' ? 'Short cycle = favor conversion-heavy, bottom-funnel channels (search, retargeting, shopping).' : data.salesCycle === '1-4 weeks' ? 'Medium cycle = balance consideration + conversion (search, social lead gen, email nurture).' : 'Long cycle = invest heavily in awareness + consideration + nurture (LinkedIn, content, display retargeting, email sequences). Expect leads to convert over multiple touchpoints.'}` : ''}
${data.webTraffic ? `Website Traffic: ${data.webTraffic} - ${data.webTraffic === 'Under 1K visits' ? 'Very low traffic = prioritize prospecting channels over retargeting. Retargeting audience will be too small.' : data.webTraffic === '1K-10K visits' ? 'Low traffic = limit retargeting to 5-10% of budget. Focus on prospecting.' : data.webTraffic === '10K-50K visits' ? 'Moderate traffic = retargeting is viable at 10-15% of budget alongside prospecting.' : 'High traffic = strong retargeting potential at 15-20% of budget. Layer frequency-capped remarketing across channels.'}` : ''}
${data.crmTool ? `CRM Stack: ${data.crmTool}, reference this in analytics_stack and attribution sections. Recommend integrations specific to ${data.crmTool}.` : ''}

=== STRATEGIC FRAMEWORK ===
${funnelAdvice}

=== MANDATORY RULES, FOLLOW ALL OF THESE ===

RULE 1, REAL COMPETITOR NAMES:
${competitorInstruction}
NEVER use generic names like "Competitor A" or "Brand X". Every competitor must be a real, recognizable company.

RULE 2, BUDGET MATH MUST ADD UP:
- total_investment should be ~$${totalBudgetMid.toLocaleString()} (the midpoint of the budget range x ${months} months)
- All channel budget_pct values MUST add to exactly 100%
- Each budget_breakdown item's pct must match its channel's budget_pct
- Calculate each channel's dollar allocation: total_investment x (pct/100)
- Then calculate impressions: (dollar allocation / CPM) x 1,000 for CPM channels, or (dollar allocation / CPC) for CPC channels
- Show the math clearly in impressions field, e.g. "~2.4M (at $7.50 CPM)" or "~18K clicks (at $2.80 CPC)"

RULE 3, USE THESE 2025-2026 INDUSTRY BENCHMARK RATES:
Google Search: CPC $1.50-$5.00 (${data.industry} typically $${industryCpcRange})
Google Display/GDN: CPM $2.50-$6.00
Meta (Facebook): CPM $8.00-$14.00, CPC $0.60-$1.80
Meta (Instagram): CPM $9.00-$16.00, CPC $0.70-$2.20
TikTok: CPM $6.00-$10.00
LinkedIn: CPM $28.00-$45.00, CPC $5.00-$12.00
YouTube Pre-Roll: CPM $15.00-$30.00, CPV $0.02-$0.06
CTV/OTT: CPM $25.00-$40.00
Programmatic Display: CPM $3.00-$7.00
Native Ads: CPM $5.00-$12.00
Snapchat: CPM $5.00-$8.00
Pinterest: CPM $4.00-$8.00
Reddit: CPM $3.50-$6.50
Podcast: CPM $18.00-$28.00
DOOH: CPM $5.00-$12.00
Spotify Audio: CPM $15.00-$25.00
Pick a SPECIFIC number within the range (not the range itself). NEVER write "Varies" or "Projected" or "TBD".

RULE 4, PROJECTED IMPRESSIONS MUST MATCH:
The top-level "projected_impressions" must approximately equal the SUM of all individual channel impressions in budget_breakdown. Show this consistency.
IMPORTANT: For CPC channels like Google Search, the top-level "projected_impressions" should show ACTUAL IMPRESSIONS (not clicks). Calculate: if you expect X clicks at Y% CTR, then impressions = clicks / CTR. Example: 1,000 clicks at 5% CTR = 20,000 impressions = "20.0K". Never label clicks as impressions.

RULE 5, REALISTIC KPI TARGETS:
Base KPI targets on the budget and industry benchmarks:
- CTR: Search 3-8%, Display 0.3-0.8%, Social 0.8-2.5%, Video 0.5-1.5%
- CPC: Derive from benchmark rates above
- CPA: Industry ${data.industry} average, adjusted for funnel stage
- ROAS: ${roasRange} for ${data.industry}
- Conversion Rate: Landing page 2-5%, e-commerce 1.5-3.5%, lead gen 5-15%

RULE 6, ADAPTIVE FLIGHT PLAN WITH REAL PHASING:
Don't use dots or symbols. Use real tactical descriptions per phase.
The flight_plan JSON keys MUST match the campaign duration:
${flightKeyInstruction}
Fill ALL columns with specific tactical actions. Do NOT leave any column empty.

RULE 7, CHANNEL TACTICS MUST BE SPECIFIC:
Don't say "Primary campaign execution" or "Audience targeting". Instead say things like:
- "Broad match + exact match keyword targeting for [specific terms], using responsive search ads with 4 headline variations"
- "Lookalike audiences (1-3%) seeded from past purchasers, running carousel + video ads with UGC creative"
- "Contextual targeting on premium publishers (Forbes, CNN) via DV360, 300x250 + 728x90 formats"
Each channel should have 3-5 specific, actionable tactics.

RULE 8, COMPETITIVE SOV WITH REAL NAMES:
competitive_sov must include ${data.brandName} AND the same real competitors from the competitors section. Include realistic estimated monthly ad spend, SOV %, their primary advertising channels, and messaging themes.

RULE 9, MINIMUM CONTENT REQUIREMENTS:
- "risks" array: Provide AT LEAST 3-4 risks (e.g., CPC spikes, low conversion rate, ad fatigue/creative burnout, budget exhaustion, audience saturation, competitive bidding pressure, platform policy changes)
- "attribution_models" array: Provide AT LEAST 3 models (e.g., Data-Driven Attribution, Last Click, First Touch, Linear, Time Decay, Position-Based, pick the most relevant 3-4 for the campaign type)
- "monitoring_tools" array: Provide AT LEAST 3 monitoring tools (e.g., Google Ads Alerts, SEMrush/SpyFu for competitive monitoring, Google Analytics 4 real-time, HubSpot/CRM notifications, social listening tools, pick appropriate ones for the budget scale)
- "budget_breakdown" cpm field: ALWAYS fill with the actual CPM or CPC rate used (e.g., "$3.00 CPC" or "$7.50 CPM"). NEVER leave as "$0.00" or empty.

RULE 10, CRO AUDIT (WEBSITE CONVERSION ANALYSIS):
If website content was provided, analyze it for conversion rate optimization (CRO) elements.
Score the landing page out of 10 based on: clear value proposition, social proof (testimonials, logos, reviews), urgency/scarcity elements, trust signals (certifications, guarantees, security badges), clear CTAs, mobile optimization indicators, page load signals, and form simplicity.
Identify exactly 3 missing or weak persuasive elements.
Provide exactly 3 specific, actionable CRO recommendations.
If no website content was provided, give a general score of "5/10" and generic best-practice recommendations.

RULE 11, HONESTY GUARDRAILS (ANTI-HALLUCINATION):
For competitive analysis: clearly label ALL spend estimates and market share figures as approximations. Use language like "estimated at" or "approximately", NEVER present competitor spend or market share as verified data.
If you are not confident a specific competitor exists in the client's niche, use hedging: "Competitors may include [X]" rather than stating definitively.
For market statistics in situation_analysis, use "industry reports suggest" or "estimates indicate", NEVER cite a specific percentage without attributing it to a general source.
For competitive_sov spend estimates: ALWAYS append "est." to spend figures. These are directional, not audited.
IMPORTANT: The "ai_data_confidence" field must honestly rate how confident you are in the competitive data: "high" (client provided competitors + well-known brands), "medium" (AI-identified competitors in a well-known industry), "low" (niche industry, competitors may not be accurate).

RULE 12, CREATIVE BRIEF PER CHANNEL:
For each channel in the media mix, generate a mini creative brief with:
- "format": The recommended primary ad format (e.g., "Responsive Search Ads", "Single Image + Carousel", "15s Pre-Roll + 6s Bumper")
- "headline_direction": 2-3 suggested headline approaches (not full headlines, just the direction/angle)
- "cta": The recommended call-to-action text
- "creative_notes": 1-2 sentences on visual/copy guidance specific to this channel
${data.creativeAssets ? 'The client has these creative assets available: ' + data.creativeAssets + '. Tailor format recommendations to what they actually have, do NOT recommend video-heavy campaigns if they have no video assets.' : 'The client has not specified available creative assets. Recommend achievable formats and flag where they may need to produce new assets.'}

RULE 13, INDUSTRY BENCHMARK COMPARISON:
Provide a benchmarks array comparing the plan's projected metrics against industry averages for ${data.industry}. Include 4-6 key metrics (CPC, CPM, CTR, CPA, conversion rate, ROAS as relevant). For each, show: the plan's target, the industry average, and whether the plan is above/below/at benchmark. ${data.pastPerformance ? 'The client reports past performance of: ' + data.pastPerformance + '. Treat this as a broad historical baseline, not as a final target. If RULE 20 provides a precise modeled target, use that exact target and explain whether beating the historical baseline is benchmark-supported.' : 'No past performance data provided, use industry midpoints as targets.'}

RULE 14, GOAL-SPECIFIC KPI ALIGNMENT:
The client's campaign goal is "${data.goal}" with primary KPI "${data.kpi}". Your entire plan must align to this goal:
${goalKpiBlock}
The benchmarks and KPI sections must ONLY include metrics relevant to "${data.goal}". Do NOT include ROAS for non-revenue goals.

RULE 19, INDUSTRY CROSS-VALIDATION:
The user selected "${data.industry}" as their industry. However, you MUST cross-check this against the brand name ("${data.brandName}"), the website content (if provided), and your own knowledge of the brand.
If the brand clearly belongs to a DIFFERENT industry than what the user selected:
1. Use the CORRECT industry for all benchmarks, channel weights, CPM/CPC rates, competitor selection, and strategic recommendations. Do NOT blindly follow the user's dropdown selection if it contradicts reality.
2. Set "detected_industry" in your JSON response to the ACTUAL industry you believe the brand belongs to (e.g., "Retail", "Automotive", "Technology").
3. Set "industry_mismatch" to true in your JSON response.
4. In the "situation_analysis.brand_position" text, note: "Note: While the input categorized this brand under ${data.industry}, our analysis indicates ${data.brandName} operates in the [correct industry] sector. All benchmarks and recommendations in this plan reflect [correct industry] standards."
If the brand DOES match the selected industry, set "detected_industry" to "${data.industry}" and "industry_mismatch" to false.
This rule takes priority over RULE 3, RULE 5, RULE 8, and RULE 13 when an industry mismatch is detected, because all of those rules reference industry-specific benchmarks.
${keywordData ? `
RULE 15, REAL KEYWORD DATA (from Google Keyword Planner):
The following keyword data is REAL, sourced from Google Keyword Planner API. Use these EXACT figures when generating search keyword recommendations. Do NOT estimate or hallucinate keyword metrics when real data is provided.
${JSON.stringify(keywordData.slice(0, 20), null, 2)}
Use the avg_monthly_searches, competition, low_cpc, and high_cpc values from above to:
- Set realistic CPC targets in the budget breakdown for search channels
- Recommend specific keywords with their actual search volumes
- Validate that the search budget can deliver the projected clicks at these CPC rates
- Flag high-competition keywords that may require higher budgets
` : ''}
${competitorIntelBlock || ''}
Return ONLY valid JSON (no markdown, no code fences, no explanation text before or after):
{"executive_summary":"3-5 sentences summarizing strategy, budget, channels, and expected outcomes with specific numbers","total_investment":"$XXX,XXX","projected_impressions":"XX.XM","target_roas":"X.X:1","target_reach_pct":"XX%","situation_analysis":{"market_overview":"2-3 paragraph analysis of ${data.industry} market trends, digital ad spend trends, and consumer behavior shifts","brand_position":"1-2 paragraph analysis of ${data.brandName}'s current market position and opportunities"},"competitors":[{"name":"REAL BRAND NAME","market_share":"XX%","strengths":"specific strengths","strategy":"their actual media/advertising strategy"}],"target_audience":{"demographics":"detailed","psychographics":"detailed lifestyle and values","geographic":"${data.location} with specifics","behavioral":"online behavior, purchase patterns, media consumption","secondary_audience":"defined segment"},"marketing_objectives":["specific, measurable objectives with numbers"],"media_objectives":["specific media metrics with targets"],"media_strategy":"2-3 paragraph strategy connecting channels to funnel stages and campaign goal","channels":[{"name":"channel name","budget_pct":"XX%","rationale":"why this channel for this goal and audience","tactics":["specific tactic 1","specific tactic 2","specific tactic 3"]}],"flight_plan":[{"channel":"name",${flightPlanKeysTemplate}}],"budget_breakdown":[{"item":"Channel Name","pct":"XX%","impressions":"X.XM (at $X.XX CPM)","cpm":"$X.XX CPM"}],"kpis":[{"kpi":"metric name","target":"specific number based on benchmarks","tool":"measurement tool","frequency":"Weekly/Bi-weekly/Monthly"}],"reporting_plan":["specific reporting actions"],"risks":[{"risk":"specific risk","impact":"High/Medium/Low","probability":"High/Medium/Low","mitigation":"specific mitigation steps"}],"attribution_models":[{"model":"model name","use_case":"when to use","credit_logic":"how credit is assigned","tool":"specific tool"}],"analytics_stack":["specific tool and its purpose"],"customer_journey":[{"stage":"Awareness/Consideration/Conversion","touchpoints":"specific channels and formats","tracking":"specific tracking method","metrics":"specific metrics"}],"competitive_sov":[{"brand":"REAL BRAND NAME","spend":"$XXK/mo est.","sov_pct":"XX%","channels":"their ad channels","messaging":"their messaging themes"}],"market_opportunities":["specific, actionable opportunities"],"monitoring_tools":[{"tool":"specific tool name","frequency":"how often","metrics":"what to track","trigger":"when to act"}],"recommendations":["specific, prioritized next steps"],"cro_audit":{"landing_page_score":"X/10","missing_elements":["missing element 1","missing element 2","missing element 3"],"recommendations":["actionable CRO tip 1","actionable CRO tip 2","actionable CRO tip 3"]},"creative_briefs":[{"channel":"channel name matching channels array","format":"recommended ad format","headline_direction":["angle 1","angle 2"],"cta":"Call-to-action text","creative_notes":"visual/copy guidance"}],"benchmarks":[{"metric":"CPC or CPM or CTR etc","plan_target":"$X.XX or X%","industry_avg":"$X.XX or X%","vs_benchmark":"Below avg or Above avg or At benchmark"}],"ai_data_confidence":"high/medium/low","detected_industry":"the ACTUAL industry this brand belongs to based on your analysis","industry_mismatch":false}`;

  return prompt;
}


// ── Health Check ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RespondIQ Backend v12.6 (Gemini 3.1 Pro + Server-Side Prompts + SSRF Protection + Keyword Planner + Competitive Intel + Benchmark Anchors)',
    model: 'gemini-3.1-pro-preview',
    thinking: 'MEDIUM',
    hosting: 'Render.com'
  });
});

// ══════════════════════════════════════════════════════════════
// LOGO.DEV BRAND SEARCH: /api/brand-search
// Server-side proxy keeps LOGO_DEV_SECRET_KEY private.
// ══════════════════════════════════════════════════════════════
const BRAND_SEARCH_CACHE = new Map();
const BRAND_SEARCH_RATE_LIMIT = new Map();
const BRAND_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BRAND_SEARCH_WINDOW_MS = 60 * 1000;
const BRAND_SEARCH_MAX_PER_WINDOW = 60;

function getBrandSearchIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function isBrandSearchRateLimited(ip) {
  const now = Date.now();
  const current = BRAND_SEARCH_RATE_LIMIT.get(ip);
  if (!current || now - current.startedAt > BRAND_SEARCH_WINDOW_MS) {
    BRAND_SEARCH_RATE_LIMIT.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > BRAND_SEARCH_MAX_PER_WINDOW;
}

function cleanBrandQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function toBrandDisplayName(domain) {
  const base = String(domain || '')
    .replace(/^www\./i, '')
    .split('.')[0]
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!base) return domain || 'Brand';
  return base.replace(/\b\w/g, ch => ch.toUpperCase());
}

function normalizeDirectBrandDomain(query) {
  const raw = cleanBrandQuery(query);
  if (!raw || /\s/.test(raw)) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const url = new URL(candidate);
    let domain = String(url.hostname || '').toLowerCase().replace(/^www\./, '');
    if (!domain || !domain.includes('.') || domain === 'localhost') return null;
    domain = domain.replace(/:\d+$/, '');
    return { name: toBrandDisplayName(domain), domain };
  } catch {
    return null;
  }
}

function logoUrlForDomain(domain) {
  const token = process.env.LOGO_DEV_PUBLISHABLE_KEY;
  if (!token || !domain) return null;
  return 'https://img.logo.dev/' + encodeURIComponent(domain) + '?token=' + encodeURIComponent(token);
}

function normalizeLogoDevResults(payload) {
  const rawResults = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  const seen = new Set();
  return rawResults.map(item => {
    const domain = String(item.domain || item.website || item.url || item.company_domain || '').trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();
    if (!domain || !domain.includes('.') || seen.has(domain)) return null;
    seen.add(domain);
    return {
      name: String(item.name || item.brand || item.company_name || toBrandDisplayName(domain)).trim() || toBrandDisplayName(domain),
      domain,
      logoUrl: logoUrlForDomain(domain),
      source: 'logo.dev'
    };
  }).filter(Boolean).slice(0, 5);
}

app.get('/api/brand-search', async (req, res) => {
  const ip = getBrandSearchIp(req);
  if (isBrandSearchRateLimited(ip)) {
    console.warn('[RespondIQ] Logo.dev brand search rate limit hit:', ip);
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const query = cleanBrandQuery(req.query.q);
  if (query.length < 2 || query.length > 80) return res.json([]);

  const direct = normalizeDirectBrandDomain(query);
  if (direct) {
    const result = [{
      name: direct.name,
      domain: direct.domain,
      logoUrl: logoUrlForDomain(direct.domain),
      source: 'direct_domain'
    }];
    console.log('[RespondIQ] Brand search direct domain:', direct.domain);
    return res.json({ results: result });
  }

  const cacheKey = query.toLowerCase();
  const cached = BRAND_SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < BRAND_SEARCH_CACHE_TTL_MS) {
    console.log('[RespondIQ] Logo.dev brand search cache hit:', query, '| results:', cached.results.length);
    return res.json({ results: cached.results });
  }

  if (!process.env.LOGO_DEV_SECRET_KEY) {
    console.warn('[RespondIQ] Logo.dev brand search fallback: logo_dev_not_configured');
    return res.json({ results: [], fallback: true, reason: 'logo_dev_not_configured' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const logoRes = await fetch('https://api.logo.dev/search?q=' + encodeURIComponent(query), {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + process.env.LOGO_DEV_SECRET_KEY,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!logoRes.ok) {
      console.warn('[RespondIQ] Logo.dev brand search fallback: logo_dev_error | status:', logoRes.status);
      return res.json({ results: [], fallback: true, reason: 'logo_dev_error' });
    }

    const payload = await logoRes.json();
    const results = normalizeLogoDevResults(payload);
    BRAND_SEARCH_CACHE.set(cacheKey, { cachedAt: Date.now(), results });
    console.log('[RespondIQ] Logo.dev brand search:', query, '| results:', results.length);
    return res.json({ results });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[RespondIQ] Logo.dev brand search fallback: logo_dev_error |', err.message);
    return res.json({ results: [], fallback: true, reason: 'logo_dev_error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DEDICATED PDF EXPORT: /api/export-pdf
// Server-rendered, page-based PDF template. This avoids browser print
// pagination drift from window.print(), chart timing, and user margin settings.
// ══════════════════════════════════════════════════════════════
function textValue(value, fallback = '-') {
  if (value === null || value === undefined) return fallback;
  const text = String(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/(\$[\d,]+(?:\.\d+)?)(?=(?![KMB]\b)[A-Za-z])/gi, '$1 ')
    .replace(/(\$[\d,]+(?:\.\d+)?)\s*totalinvestment/gi, '$1 total investment')
    .replace(/(\$[\d,]+(?:\.\d+)?)\s*total\s+investment/gi, '$1 total investment')
    .replace(/\btotalinvestment\b/gi, 'total investment')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(v => v !== null && v !== undefined) : [];
}

function parsePct(value) {
  const n = parseFloat(String(value || '').replace('%', ''));
  return Number.isFinite(n) ? n : 0;
}

function parseMoney(value) {
  const n = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function totalCampaignBudget(data, plan) {
  const fromPlan = parseMoney(plan && plan.total_investment);
  if (fromPlan) return fromPlan;
  const bInfo = BUDGET_MAP[data.budget] || BUDGET_MAP['$10,000 - $25,000'];
  const months = DURATION_MONTHS[data.campaignDuration] || 3;
  return bInfo.mid * months;
}

function money(value) {
  const n = Number(value) || 0;
  return '$' + Math.round(n).toLocaleString('en-US');
}

function downloadFilename(value) {
  return textValue(value, 'media-plan')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'media-plan';
}

function inferFlightColumns(duration) {
  if (duration === '12 Months (Annual)') return { headers: ['Q1', 'Q2', 'Q3', 'Q4'], keys: ['q1', 'q2', 'q3', 'q4'] };
  if (duration === '6 Months') return { headers: ['Month 1', 'Months 2-3', 'Months 4-5', 'Month 6'], keys: ['month_1', 'month_2_3', 'month_4_5', 'month_6'] };
  if (duration === '8 Weeks') return { headers: ['Wks 1-2', 'Wks 3-4', 'Wks 5-6', 'Wks 7-8'], keys: ['wk1_2', 'wk3_4', 'wk5_6', 'wk7_8'] };
  if (duration === '4 Weeks') return { headers: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], keys: ['wk1', 'wk2', 'wk3', 'wk4'] };
  return { headers: ['Wks 1-3', 'Wks 4-6', 'Wks 7-9', 'Wks 10-12'], keys: ['wk1_3', 'wk4_6', 'wk7_9', 'wk10_12'] };
}

function redactKnownPersonalText(value, personal = {}) {
  if (typeof value !== 'string') return value;
  let text = value;
  [personal.userName, personal.userEmail, personal.userPhone]
    .filter(v => typeof v === 'string' && v.trim().length >= 3)
    .forEach(raw => {
      const escaped = raw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'gi'), '[redacted personal info]');
    });
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g, '[redacted phone]');
}

function redactKnownPersonalData(value, personal = {}) {
  if (Array.isArray(value)) return value.map(item => redactKnownPersonalData(item, personal));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(key => { out[key] = redactKnownPersonalData(value[key], personal); });
    return out;
  }
  return redactKnownPersonalText(value, personal);
}

function stripPersonalFieldsForAI(raw = {}) {
  const personal = {
    userName: raw.userName,
    userEmail: raw.userEmail,
    userPhone: raw.userPhone
  };
  const {
    userName,
    userEmail,
    userPhone,
    marketingConsent,
    privacyConsent,
    consentTimestamp,
    ...planningData
  } = raw || {};
  return redactKnownPersonalData(planningData, personal);
}

function createRespondIqPdfBuffer(data, plan) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (err) {
    err.code = 'PDFKIT_MISSING';
    throw err;
  }

  const d = data || {};
  const p = plan || {};
  const brand = textValue(d.brandName, 'Client');
  const campaign = textValue(d.campaignName, 'Media Plan');
  const generatedAt = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const totalBudget = totalCampaignBudget(d, p);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 46, left: 46, right: 46, bottom: 18 },
    info: {
      Title: campaign + ' - RespondIQ Media Plan',
      Author: 'RespondIQ\nby\nResponsive MTS',
      Subject: 'AI-generated media plan',
    }
  });

  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));

  const palette = {
    ink: '#1f2937',
    muted: '#64748b',
    light: '#f8fafc',
    border: '#dbe3ef',
    navy: '#2f3b59',
    blue: '#2f80ed',
    orange: '#ff6b35',
    teal: '#4aa69a',
    amber: '#c27a22',
    gray: '#eef2f7'
  };

  const state = {
    pageNo: 0,
    y: 0,
    left: doc.page.margins.left,
    right: doc.page.width - doc.page.margins.right,
    top: doc.page.margins.top,
    bottom: doc.page.height - 64,
    currentNo: '',
    currentTitle: '',
    currentColor: palette.navy,
  };
  state.width = state.right - state.left;

  function resetPageMetrics() {
    state.left = doc.page.margins.left;
    state.right = doc.page.width - doc.page.margins.right;
    state.top = doc.page.margins.top;
    state.bottom = doc.page.height - 64;
    state.width = state.right - state.left;
  }

  function paintPageBackground(fill = '#ffffff') {
    doc.save();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(fill);
    doc.restore();
  }

  function drawHeaderFooter() {
    const footerY = doc.page.height - 38;
    paintPageBackground('#ffffff');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(palette.muted)
      .text('RESPONDIQ', state.left, 24, { width: 90 });
    doc.font('Helvetica').fontSize(7).fillColor(palette.muted)
      .text(campaign, state.left + 82, 24, { width: state.width - 190 });
    doc.moveTo(state.left, 38).lineTo(state.right, 38).lineWidth(0.5).strokeColor(palette.border).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(palette.muted)
      .text('RespondIQ - ' + campaign, state.left, footerY, { width: state.width * 0.72, lineBreak: false });
    doc.text('Page ' + state.pageNo, state.right - 48, footerY, { width: 48, align: 'right', lineBreak: false });
  }

  function sectionHeader(no, title, color, continued) {
    doc.moveTo(state.left, state.y).lineTo(state.left + 64, state.y).lineWidth(2).strokeColor(color).stroke();
    state.y += 12;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(color).text((continued ? no + ' CONT.' : no).toUpperCase(), state.left, state.y);
    state.y += 13;
    doc.circle(state.left + 6, state.y + 7, 4).fill(color);
    doc.font('Helvetica-Bold').fontSize(21).fillColor(palette.ink).text(title, state.left + 18, state.y, { width: state.width - 18 });
    state.y += 36;
  }

  function startSection(no, title, color = palette.navy) {
    doc.addPage();
    resetPageMetrics();
    state.pageNo += 1;
    state.y = state.top;
    state.currentNo = no;
    state.currentTitle = title;
    state.currentColor = color;
    drawHeaderFooter();
    sectionHeader(no, title, color, false);
  }

  function continueSection() {
    doc.addPage();
    resetPageMetrics();
    state.pageNo += 1;
    state.y = state.top;
    drawHeaderFooter();
    sectionHeader(state.currentNo, state.currentTitle, state.currentColor, true);
  }

  function ensureSpace(height) {
    if (state.y + height > state.bottom) continueSection();
  }

  function paragraph(text, options = {}) {
    const size = options.size || 10.5;
    const width = options.width || state.width;
    const lineGap = options.lineGap ?? 3;
    const x = options.x || state.left;
    const value = textValue(text, '');
    if (!value) return;
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    const h = doc.heightOfString(value, { width, lineGap });
    ensureSpace(h + 8);
    doc.fillColor(options.color || palette.ink).text(value, x, state.y, { width, lineGap });
    state.y += h + (options.after ?? 10);
  }

  function subsection(title, color = palette.ink) {
    ensureSpace(28);
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(color).text(title, state.left, state.y);
    state.y += 21;
  }

  function card(x, y, w, h, fill = palette.light, stroke = palette.border) {
    doc.roundedRect(x, y, w, h, 8).fillAndStroke(fill, stroke);
  }

  function metricCards(metrics) {
    const gap = 8;
    const w = (state.width - gap * (metrics.length - 1)) / metrics.length;
    ensureSpace(70);
    metrics.forEach((m, i) => {
      const x = state.left + i * (w + gap);
      card(x, state.y, w, 58, m.fill, m.fill);
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(textValue(m.value), x + 10, state.y + 13, { width: w - 20 });
      doc.font('Helvetica').fontSize(7).fillColor('#ffffff').text(textValue(m.label), x + 10, state.y + 36, { width: w - 20 });
    });
    state.y += 76;
  }

  function infoGrid(items, columns = 2) {
    const gap = 8;
    const w = (state.width - gap * (columns - 1)) / columns;
    const rows = [];
    for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
    let y = state.y;
    rows.forEach(row => {
      const heights = row.map(item => {
        const value = textValue(item.value);
        doc.font('Helvetica').fontSize(10);
        const valueH = doc.heightOfString(value, { width: w - 22, lineGap: 2 });
        return Math.max(62, valueH + 42);
      });
      const rowH = Math.max(...heights);
      if (y + rowH > state.bottom) {
        state.y = y;
        continueSection();
        y = state.y;
      }
      row.forEach((item, idx) => {
        const x = state.left + idx * (w + gap);
        const value = textValue(item.value);
        card(x, y, w, rowH);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(palette.muted)
          .text(textValue(item.label).toUpperCase(), x + 11, y + 11, { width: w - 22, lineBreak: false, ellipsis: true });
        doc.font('Helvetica').fontSize(10).fillColor(palette.ink)
          .text(value, x + 11, y + 29, { width: w - 22, lineGap: 2, height: rowH - 39 });
      });
      y += rowH + gap;
    });
    state.y = y + 8;
  }

  function bulletList(items, color = palette.blue) {
    asArray(items).forEach(item => {
      const value = typeof item === 'string' ? item : JSON.stringify(item);
      doc.font('Helvetica').fontSize(10);
      const h = Math.max(30, doc.heightOfString(textValue(value), { width: state.width - 30, lineGap: 2 }) + 18);
      ensureSpace(h + 5);
      card(state.left, state.y, state.width, h, '#ffffff', palette.border);
      doc.rect(state.left, state.y, 3, h).fill(color);
      doc.font('Helvetica').fontSize(10).fillColor(palette.ink)
        .text(textValue(value), state.left + 16, state.y + 9, { width: state.width - 30, lineGap: 2, height: h - 16 });
      state.y += h + 6;
    });
    state.y += 4;
  }

  function drawTable(columns, rows, options = {}) {
    const widths = options.widths || columns.map(() => state.width / columns.length);
    const headerFill = options.headerFill || palette.gray;
    const fontSize = Math.max(options.fontSize || 8.8, 7.8);
    const headerHeight = options.headerHeight || 26;
    const section = { no: state.currentNo, title: state.currentTitle, color: state.currentColor };

    function drawHeader() {
      ensureSpace(headerHeight + 18);
      let x = state.left;
      doc.rect(state.left, state.y, state.width, headerHeight).fill(headerFill);
      columns.forEach((col, i) => {
        doc.font('Helvetica-Bold').fontSize(Math.max(options.headerFontSize || 8, 7.5)).fillColor(options.headerColor || palette.navy)
          .text(textValue(col).toUpperCase(), x + 7, state.y + 8, { width: widths[i] - 10 });
        x += widths[i];
      });
      state.y += headerHeight;
    }

    drawHeader();
    rows.forEach((row, r) => {
      doc.font('Helvetica').fontSize(fontSize);
      const heights = row.map((cell, i) => doc.heightOfString(textValue(cell), { width: widths[i] - 12, lineGap: 1 }) + 14);
      const rowH = Math.max(options.minRowHeight || 30, ...heights);
      if (state.y + rowH > state.bottom) {
        state.currentNo = section.no;
        state.currentTitle = section.title;
        state.currentColor = section.color;
        continueSection();
        drawHeader();
      }
      doc.rect(state.left, state.y, state.width, rowH).fill(r % 2 ? '#f6f8fb' : '#ffffff');
      let x = state.left;
      row.forEach((cell, i) => {
        doc.font('Helvetica').fontSize(fontSize).fillColor(palette.ink)
          .text(textValue(cell), x + 7, state.y + 8, { width: widths[i] - 12, lineGap: 1 });
        x += widths[i];
      });
      doc.moveTo(state.left, state.y + rowH).lineTo(state.right, state.y + rowH).lineWidth(0.4).strokeColor(palette.border).stroke();
      state.y += rowH;
    });
    state.y += 18;
  }

  function drawBars(items, labelKey, valueKey, options = {}) {
    const max = Math.max(1, ...items.map(it => parsePct(it[valueKey])));
    items.forEach((it, i) => {
      const label = textValue(it[labelKey]);
      const pct = parsePct(it[valueKey]);
      ensureSpace(25);
      doc.font('Helvetica').fontSize(9).fillColor(palette.ink).text(label, state.left, state.y + 2, { width: 145, ellipsis: true });
      doc.roundedRect(state.left + 150, state.y, 250, 12, 4).fill('#eef2f7');
      doc.roundedRect(state.left + 150, state.y, Math.max(4, 250 * (pct / max)), 12, 4).fill(options.color || palette.blue);
      doc.font('Helvetica').fontSize(9).fillColor(palette.muted).text((pct || 0).toFixed(0) + '%', state.left + 412, state.y + 1, { width: 50, align: 'right' });
      state.y += 24;
      if (i === items.length - 1) state.y += 6;
    });
  }

  function drawClosingPage() {
    doc.addPage();
    resetPageMetrics();
    paintPageBackground('#ffffff');
    const midY = 220;
    doc.rect(0, 0, doc.page.width, 170).fill(palette.navy);
    doc.rect(0, 170, doc.page.width, 8).fill(palette.orange);
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#ffffff').text('RESPONDIQ', state.left, 62, { align: 'center', width: state.width });
    doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text('by', state.left, 93, { align: 'center', width: state.width });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('Responsive MTS', state.left, 110, { align: 'center', width: state.width });
    doc.font('Helvetica-Bold').fontSize(42).fillColor(palette.ink).text('Thank You', state.left, midY, { align: 'center', width: state.width });
    doc.font('Helvetica').fontSize(12).fillColor(palette.muted).text('Prepared for ' + brand, state.left, midY + 58, { align: 'center', width: state.width });
    card(state.left + 72, midY + 105, state.width - 144, 102, '#fff7ed', '#ffd7c2');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(palette.navy).text('NEED DEEPER STRATEGY OR FULL-SERVICE EXECUTION?', state.left + 92, midY + 128, { width: state.width - 184, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(palette.orange).text('info@responsivemts.com', state.left + 92, midY + 155, { width: state.width - 184, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor(palette.muted).text('responsivemts.com', state.left + 92, midY + 179, { width: state.width - 184, align: 'center' });
    doc.rect(state.left + 145, doc.page.height - 92, state.width - 290, 2).fill(palette.orange);
  }

  function drawCover() {
    resetPageMetrics();
    paintPageBackground('#ffffff');
    doc.rect(0, 0, doc.page.width, 268).fill(palette.navy);
    doc.rect(0, 268, doc.page.width, 9).fill(palette.orange);
    doc.rect(state.left, 64, 66, 4).fill(palette.orange);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('RESPONDIQ', state.left, 78, { width: state.width });
    doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text('by', state.left, 106, { width: state.width });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('Responsive MTS', state.left, 121, { width: state.width });
    const coverTitleSize = campaign.length > 46 ? 29 : campaign.length > 30 ? 34 : 38;
    doc.font('Helvetica-Bold').fontSize(coverTitleSize).fillColor('#ffffff').text(campaign, state.left, 154, { width: state.width - 38, height: 66, lineGap: 2, ellipsis: true });
    doc.font('Helvetica').fontSize(13).fillColor('#e2e8f0').text('Client-ready media strategy generated by the RespondIQ AI Engine', state.left, 229, { width: state.width - 40 });

    card(state.left, 312, state.width, 156, '#ffffff', palette.border);
    doc.rect(state.left, 312, 7, 156).fill(palette.orange);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(palette.ink).text('Media Plan', state.left + 28, 344, { width: state.width - 56 });
    doc.font('Helvetica').fontSize(12).fillColor(palette.muted).text('Prepared for ' + brand, state.left + 28, 389, { width: state.width - 56 });
    doc.font('Helvetica').fontSize(10).fillColor(palette.muted).text('Prepared ' + generatedAt, state.left + 28, 416, { width: state.width - 56 });

    const coverMetrics = [
      { label: 'Investment', value: p.total_investment || money(totalBudget), color: palette.navy },
      { label: 'Impressions', value: p.projected_impressions || '-', color: palette.blue },
      { label: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? 'ROAS' : 'Primary KPI', value: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? p.target_roas : textValue(d.kpi).split('(')[0].trim(), color: palette.orange },
    ];
    const gap = 10;
    const metricW = (state.width - gap * 2) / 3;
    coverMetrics.forEach((metric, idx) => {
      const x = state.left + idx * (metricW + gap);
      const metricValue = textValue(metric.value);
      const metricSize = metricValue.length > 18 ? 13 : metricValue.length > 12 ? 15 : 18;
      doc.roundedRect(x, 512, metricW, 82, 8).fill(metric.color);
      doc.font('Helvetica-Bold').fontSize(metricSize).fillColor('#ffffff').text(metricValue, x + 12, 535, { width: metricW - 24, height: 22, ellipsis: true });
      doc.font('Helvetica').fontSize(8).fillColor('#ffffff').text(textValue(metric.label).toUpperCase(), x + 12, 562, { width: metricW - 24 });
    });

    doc.font('Helvetica-Bold').fontSize(8).fillColor(palette.orange).text('STRATEGY DELIVERABLE', state.left, doc.page.height - 102, { width: state.width, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(palette.muted).text('Generated by RespondIQ for media planning review and execution readiness.', state.left, doc.page.height - 83, { width: state.width, align: 'center' });
  }

  function drawSnapshot() {
    startSection('Plan Snapshot', campaign + ' - At a Glance', palette.orange);
    metricCards([
      { value: p.total_investment || money(totalBudget), label: 'Total Investment', fill: palette.navy },
      { value: p.projected_impressions || '-', label: 'Projected Impressions', fill: palette.blue },
      { value: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? p.target_roas : textValue(d.kpi).split('(')[0].trim(), label: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? 'Target ROAS' : 'Primary KPI', fill: palette.orange },
      { value: p.target_reach_pct || '-', label: 'Target Reach', fill: palette.teal },
    ]);
    subsection('Campaign Profile', palette.orange);
    infoGrid([
      { label: 'Client', value: brand },
      { label: 'Duration', value: d.campaignDuration },
      { label: 'Budget', value: d.budget },
      { label: 'Goal', value: d.goal },
      { label: 'Locations', value: d.location },
      { label: 'Audience', value: [d.ageRange, d.gender, d.income].filter(Boolean).join(' | ') },
    ], 2);
    if (asArray(p.budget_breakdown).length) {
      subsection('Channel Mix', palette.blue);
      drawBars(asArray(p.budget_breakdown), 'item', 'pct', { color: palette.blue });
    }
  }

  drawCover();
  drawSnapshot();

  startSection('Section 01', 'Executive Summary', palette.navy);
  infoGrid([
    { label: 'Client', value: brand },
    { label: 'Campaign', value: campaign },
    { label: 'Duration', value: d.campaignDuration },
    { label: 'Monthly Budget', value: d.budget },
  ], 2);
  paragraph(p.executive_summary, { size: 10, lineGap: 4 });
  subsection('Investment Overview');
  metricCards([
    { value: p.total_investment || money(totalBudget), label: 'Total Media Investment', fill: palette.navy },
    { value: p.projected_impressions || '-', label: 'Projected Impressions', fill: palette.blue },
    { value: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? p.target_roas : textValue(d.kpi).split('(')[0].trim(), label: ['Sales & Conversions', 'Customer Retention'].includes(d.goal) ? 'Target ROAS' : 'Primary KPI', fill: palette.orange },
    { value: p.target_reach_pct || '-', label: 'Reach (Target Audience)', fill: palette.teal },
  ]);

  startSection('Section 02', 'Situation Analysis', palette.navy);
  subsection('Market Overview');
  paragraph(p.situation_analysis && p.situation_analysis.market_overview, { lineGap: 4 });
  subsection('Brand Position');
  paragraph(p.situation_analysis && p.situation_analysis.brand_position, { lineGap: 4 });
  if (asArray(p.competitors).length) {
    subsection('Competitive Analysis');
    drawTable(
      ['Competitor', 'Market Share', 'Key Strengths', 'Media Strategy'],
      asArray(p.competitors).map(c => [c.name, c.market_share, c.strengths, c.strategy]),
      { widths: [95, 70, 170, 168], fontSize: 7.5 }
    );
  }

  startSection('Section 03', 'Target Audience', palette.blue);
  const audience = p.target_audience || {};
  infoGrid([
    { label: 'Demographics', value: audience.demographics },
    { label: 'Psychographics', value: audience.psychographics },
    { label: 'Geographic', value: audience.geographic },
    { label: 'Behavioral', value: audience.behavioral },
  ], 2);
  subsection('Secondary Audience');
  paragraph(audience.secondary_audience);

  startSection('Section 04', 'Campaign Objectives', palette.blue);
  subsection('Marketing Objectives');
  bulletList(p.marketing_objectives, palette.blue);
  subsection('Media Objectives');
  bulletList(p.media_objectives, palette.blue);

  startSection('Section 05', 'Media Strategy', palette.navy);
  paragraph(p.media_strategy, { lineGap: 4 });

  startSection('Section 06', 'Media Channel Mix & Tactics', palette.orange);
  asArray(p.channels).forEach(ch => {
    subsection(textValue(ch.name) + ' - ' + textValue(ch.budget_pct, '0%') + ' of Budget', palette.ink);
    paragraph(ch.rationale, { size: 8.5, color: palette.muted, after: 6 });
    bulletList(ch.tactics, palette.orange);
  });

  startSection('Section 07', 'Flight Plan & Calendar', palette.orange);
  const flight = inferFlightColumns(d.campaignDuration);
  drawTable(
    ['Channel', ...flight.headers],
    asArray(p.flight_plan).map(fp => [fp.channel, ...flight.keys.map(k => fp[k] || '-')]),
    { widths: [84, 104, 104, 104, 107], fontSize: 6.7, minRowHeight: 42, headerFill: '#fff1eb', headerColor: palette.orange }
  );

  startSection('Section 08', 'Budget Breakdown', palette.orange);
  drawBars(asArray(p.budget_breakdown), 'item', 'pct', { color: palette.orange });
  drawTable(
    ['Line Item', '%', 'Amount', 'Impressions / Clicks', 'CPM / CPC'],
    asArray(p.budget_breakdown).map(bb => {
      const pct = parsePct(bb.pct);
      return [bb.item, bb.pct, pct ? money(totalBudget * pct / 100) : '-', bb.impressions, bb.cpm];
    }),
    { widths: [130, 48, 82, 150, 93], fontSize: 7.5, headerFill: '#fff1eb', headerColor: palette.orange }
  );

  startSection('Section 09', 'KPIs & Measurement Plan', palette.teal);
  subsection('Key Performance Indicators', palette.ink);
  drawTable(
    ['KPI', 'Target', 'Tool', 'Frequency'],
    asArray(p.kpis).map(k => [k.kpi, k.target, k.tool, k.frequency]),
    { widths: [130, 120, 160, 93], fontSize: 7.8, headerFill: '#e9f4ff', headerColor: palette.blue }
  );
  subsection('Reporting & Optimization');
  bulletList(p.reporting_plan, palette.teal);

  startSection('Section 10', 'Risks & Contingency Planning', palette.amber);
  drawTable(
    ['Risk', 'Impact', 'Probability', 'Mitigation'],
    asArray(p.risks).map(r => [r.risk, r.impact, r.probability, r.mitigation]),
    { widths: [145, 70, 82, 206], fontSize: 7.8, headerFill: '#fff7e8', headerColor: palette.amber }
  );

  startSection('Section 11', 'Attribution & Analytics Framework', palette.teal);
  subsection('Multi-Touch Attribution');
  drawTable(
    ['Model', 'Use Case', 'Credit Logic', 'Tool'],
    asArray(p.attribution_models).map(a => [a.model, a.use_case, a.credit_logic, a.tool]),
    { widths: [115, 130, 155, 103], fontSize: 7.5, headerFill: '#e8f7f4', headerColor: palette.teal }
  );
  subsection('Analytics Stack');
  bulletList(p.analytics_stack, palette.teal);
  subsection('Customer Journey Tracking');
  drawTable(
    ['Stage', 'Touchpoints', 'Tracking', 'Metrics'],
    asArray(p.customer_journey).map(j => [j.stage, j.touchpoints, j.tracking, j.metrics]),
    { widths: [90, 145, 140, 128], fontSize: 7.2, headerFill: '#e8f7f4', headerColor: palette.teal }
  );

  startSection('Section 12', 'Competitive Intelligence', palette.navy);
  subsection('Share of Voice Analysis');
  drawBars(asArray(p.competitive_sov), 'brand', 'sov_pct', { color: palette.navy });
  drawTable(
    ['Brand', 'Est. Spend', 'SOV %', 'Channels', 'Messaging'],
    asArray(p.competitive_sov).map(s => [s.brand, s.spend, s.sov_pct, s.channels, s.messaging]),
    { widths: [105, 78, 55, 135, 130], fontSize: 6.8 }
  );
  if (p.ai_data_confidence) paragraph('Data Confidence: ' + p.ai_data_confidence, { size: 8, color: palette.orange });
  subsection('Market Opportunities');
  bulletList(p.market_opportunities, palette.blue);
  subsection('Monitoring & Response Strategy');
  drawTable(
    ['Tool', 'Frequency', 'Key Metrics', 'Trigger'],
    asArray(p.monitoring_tools).map(m => [m.tool, m.frequency, m.metrics, m.trigger]),
    { widths: [130, 84, 150, 139], fontSize: 7.2 }
  );

  startSection('Section 13', 'Recommendations & Next Steps', palette.navy);
  bulletList(p.recommendations, palette.blue);

  if (p.cro_audit) {
    startSection('Section 14', 'Website & Conversion Audit', palette.amber);
    infoGrid([
      { label: 'Landing Page Score', value: p.cro_audit.landing_page_score },
      { label: 'Audit Basis', value: 'Value proposition clarity, social proof, urgency elements, trust signals, CTA effectiveness, and mobile experience.' },
    ], 2);
    subsection('Missing Elements');
    bulletList(p.cro_audit.missing_elements, palette.amber);
    subsection('Recommendations');
    bulletList(p.cro_audit.recommendations, palette.teal);
  }

  if (asArray(p.creative_briefs).length) {
    startSection('Section 15', 'Creative Brief by Channel', palette.amber);
    const briefs = asArray(p.creative_briefs);
    const gap = 10;
    const w = (state.width - gap) / 2;
    briefs.forEach((b, idx) => {
      const x = state.left + (idx % 2) * (w + gap);
      if (idx % 2 === 0) ensureSpace(142);
      const y = state.y;
      card(x, y, w, 128, '#ffffff', palette.border);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(palette.blue).text(textValue(b.channel), x + 10, y + 10, { width: w - 20 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(palette.muted).text('FORMAT', x + 10, y + 29);
      doc.font('Helvetica').fontSize(7.5).fillColor(palette.ink).text(textValue(b.format), x + 10, y + 39, { width: w - 20 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(palette.muted).text('HEADLINE DIRECTION', x + 10, y + 57);
      const headlines = asArray(b.headline_direction).length ? asArray(b.headline_direction).join('; ') : textValue(b.headline_direction);
      doc.font('Helvetica').fontSize(7.3).fillColor(palette.ink).text(headlines, x + 10, y + 67, { width: w - 20, height: 24 });
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(palette.muted).text('CTA', x + 10, y + 93);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(palette.blue).text(textValue(b.cta), x + 10, y + 103, { width: w - 20 });
      doc.font('Helvetica').fontSize(7).fillColor(palette.muted).text(textValue(b.creative_notes), x + 10, y + 114, { width: w - 20, height: 12 });
      if (idx % 2 === 1 || idx === briefs.length - 1) state.y += 140;
    });
  }

  if (asArray(p.benchmarks).length) {
    startSection('Section 16', 'Industry Benchmark Comparison', palette.teal);
    drawTable(
      ['Metric', 'Plan Target', 'Industry Avg', 'vs. Benchmark'],
      asArray(p.benchmarks).map(b => [b.metric, b.plan_target, b.industry_avg, b.vs_benchmark]),
      { widths: [135, 120, 150, 98], fontSize: 7.8, headerFill: '#e9f4ff', headerColor: palette.blue }
    );
    let attributionText = '';
    const planSources = p._benchmark_sources || [];
    if (Array.isArray(planSources) && planSources.length > 0) {
      const premium = planSources.filter(s => s.tier === 'premium').slice(0, 3);
      const sourcesToUse = premium.length > 0 ? premium : planSources.slice(0, 3);
      attributionText = ' via ' + sourcesToUse.map(s => s.short_name).join(', ');
    }
    paragraph('Benchmarks based on 2025-2026 industry aggregates' + attributionText + '. Actual performance varies by creative quality, landing page experience, and competitive landscape.', { size: 8, color: palette.muted });
  }

  if (asArray(p._keywordResults).length) {
    startSection('Section 17', 'Search Keyword Recommendations', palette.navy);
    drawTable(
      ['Keyword', 'Avg. Monthly Searches', 'Competition', 'Est. CPC Range'],
      asArray(p._keywordResults).slice(0, 10).map(kw => [kw.keyword, kw.avg_monthly_searches, kw.competition, [kw.low_cpc, kw.high_cpc].filter(Boolean).join(' - ') || 'N/A']),
      { widths: [180, 125, 90, 108], fontSize: 7.5 }
    );
  }

  startSection('Notice', 'Important Notice', palette.muted);
  paragraph('This media plan was generated using AI and should be treated as a strategic starting point, not a final deliverable. All budget allocations, estimated rates, audience estimates, and competitive data are approximations based on industry benchmarks and publicly available sources. Actual performance will vary based on creative quality, market conditions, targeting precision, and competitive dynamics. Validate all figures using platform-specific tools and consult the media team before committing spend.', { lineGap: 4 });

  drawClosingPage();

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.end();
  return done;
}

app.post('/api/export-pdf', async (req, res) => {
  try {
    const data = req.body && req.body.form_data;
    const plan = req.body && req.body.plan;
    if (!data || !plan) {
      return res.status(400).json({ error: 'form_data and plan are required' });
    }

    const pdf = await createRespondIqPdfBuffer(data, plan);
    const filename = downloadFilename(data.campaignName || data.brandName || 'media-plan') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    if (err.code === 'PDFKIT_MISSING') {
      console.error('[RespondIQ] PDF export dependency missing:', err.message);
      return res.status(501).json({ error: 'PDF export dependency is not installed. Run npm install before using server-side PDF export.' });
    }
    console.error('[RespondIQ] PDF export error:', err.message);
    res.status(500).json({ error: 'PDF export failed: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// DEDICATED POWERPOINT EXPORT: /api/export-pptx
// Editable server-rendered slide deck using a fixed RespondIQ template.
// ══════════════════════════════════════════════════════════════
async function createRespondIqPptxBuffer(data, plan) {
  let PptxGenJS;
  try {
    const mod = require('pptxgenjs');
    PptxGenJS = mod.default || mod;
  } catch (err) {
    err.code = 'PPTXGEN_MISSING';
    throw err;
  }

  const d = data || {};
  const p = plan || {};
  const brand = textValue(d.brandName, 'Client');
  const campaign = textValue(d.campaignName, 'Media Plan');
  const generatedAt = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const totalBudget = totalCampaignBudget(d, p);
  const isSalesGoal = ['Sales & Conversions', 'Customer Retention'].includes(d.goal);
  const primaryKpi = isSalesGoal ? p.target_roas : textValue(d.kpi).split('(')[0].trim();

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'RespondIQ\nby\nResponsive MTS';
  pptx.company = 'Responsive MTS';
  pptx.subject = 'AI-generated media plan';
  pptx.title = campaign + ' - RespondIQ Media Plan';
  pptx.lang = 'en-US';
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'en-US'
  };

  const ShapeType = pptx.ShapeType || PptxGenJS.ShapeType || {};
  const RECT = ShapeType.rect || 'rect';
  const W = 13.333;
  const H = 7.5;

  const palette = {
    ink: '1F2937',
    muted: '64748B',
    light: 'F8FAFC',
    border: 'DBE3EF',
    navy: '2F3B59',
    deep: '111827',
    blue: '2F80ED',
    orange: 'FF6B35',
    teal: '4AA69A',
    amber: 'C27A22',
    gray: 'EEF2F7',
    white: 'FFFFFF'
  };

  let slideNo = 0;

  function clean(value, max = 500, fallback = '-') {
    let text = textValue(value, fallback).replace(/\s+/g, ' ').trim();
    if (max && text.length > max) text = text.slice(0, Math.max(0, max - 3)).replace(/\s+\S*$/, '') + '...';
    return text;
  }

  function listText(items, maxItems = 5, maxChars = 115) {
    const values = asArray(items).slice(0, maxItems).map(item => {
      if (typeof item === 'string') return '- ' + clean(item, maxChars, '');
      return '- ' + clean(JSON.stringify(item), maxChars, '');
    }).filter(Boolean);
    return values.length ? values.join('\n') : '-';
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function addRect(slide, x, y, w, h, fill, line = fill) {
    slide.addShape(RECT, {
      x, y, w, h,
      fill: { color: fill },
      line: { color: line, transparency: line === fill ? 100 : 0, pt: 0.7 }
    });
  }

  function addText(slide, text, x, y, w, h, opts = {}) {
    slide.addText(clean(text, opts.max || 500, opts.fallback || ''), {
      x, y, w, h,
      fontFace: opts.fontFace || 'Aptos',
      fontSize: opts.fontSize || 12,
      color: opts.color || palette.ink,
      bold: !!opts.bold,
      italic: !!opts.italic,
      align: opts.align || 'left',
      valign: opts.valign || 'top',
      margin: opts.margin ?? 0.04,
      breakLine: false,
      fit: opts.fit || 'shrink'
    });
  }

  function addBackground(slide, fill = palette.white) {
    slide.background = { color: fill };
    addRect(slide, 0, 0, W, H, fill);
  }

  function addFooter(slide, title) {
    addRect(slide, 0.62, 7.05, 12.1, 0.01, palette.border);
    addText(slide, 'RESPONDIQ', 0.62, 7.12, 1.25, 0.18, { fontSize: 6.7, color: palette.muted, bold: true, margin: 0 });
    addText(slide, clean(title || campaign, 76), 1.52, 7.12, 8.5, 0.18, { fontSize: 6.7, color: palette.muted, margin: 0 });
    addText(slide, String(slideNo), 12.24, 7.12, 0.48, 0.18, { fontSize: 6.7, color: palette.muted, align: 'right', margin: 0 });
  }

  function addHeader(slide, section, title, accent = palette.navy) {
    addText(slide, 'RESPONDIQ', 0.62, 0.28, 1.35, 0.2, { fontSize: 7, color: palette.muted, bold: true, margin: 0 });
    addText(slide, clean(campaign, 80), 1.52, 0.28, 8.4, 0.2, { fontSize: 7, color: palette.muted, margin: 0 });
    addRect(slide, 0.62, 0.58, 0.72, 0.04, accent);
    addText(slide, section.toUpperCase(), 0.62, 0.78, 2.4, 0.22, { fontSize: 7.2, color: accent, bold: true, margin: 0 });
    addText(slide, title, 0.62, 1.02, 8.6, 0.45, { fontSize: 22, color: palette.ink, bold: true, margin: 0, max: 84 });
  }

  function newSlide(section, title, accent = palette.navy) {
    const slide = pptx.addSlide();
    slideNo += 1;
    addBackground(slide);
    addHeader(slide, section, title, accent);
    addFooter(slide, title);
    return slide;
  }

  function addPanel(slide, x, y, w, h, title, body, accent = palette.navy, opts = {}) {
    const bodyText = clean(body, opts.max || 460, '');
    const baseBodySize = opts.bodySize || 10.4;
    const minBodySize = opts.minBodySize || 6.3;
    const bodySize = bodyText.length > 520 ? Math.max(minBodySize, baseBodySize - 1.5) :
                     bodyText.length > 360 ? Math.max(minBodySize, baseBodySize - 1.0) :
                     bodyText.length > 220 ? Math.max(minBodySize, baseBodySize - 0.4) :
                     baseBodySize;
    addRect(slide, x, y, w, h, opts.fill || palette.light, opts.line || palette.border);
    addRect(slide, x, y, 0.06, h, accent);
    addText(slide, title, x + 0.18, y + 0.18, w - 0.36, 0.24, { fontSize: opts.titleSize || 8.8, color: accent, bold: true, max: 70 });
    addText(slide, bodyText, x + 0.18, y + 0.48, w - 0.36, h - 0.62, { fontSize: bodySize, color: opts.bodyColor || palette.ink, max: opts.max || 460, fit: 'shrink' });
  }

  function addMetric(slide, x, y, w, h, value, label, fill) {
    addRect(slide, x, y, w, h, fill);
    addText(slide, value, x + 0.18, y + 0.22, w - 0.36, 0.34, { fontSize: String(value || '').length > 12 ? 15 : 19, color: palette.white, bold: true, max: 22 });
    addText(slide, label.toUpperCase(), x + 0.18, y + 0.67, w - 0.36, 0.18, { fontSize: 6.8, color: palette.white, max: 38 });
  }

  function addBars(slide, items, labelKey, valueKey, x, y, w, rowH, accent, maxRows = 9) {
    const rows = asArray(items).slice(0, maxRows);
    const max = Math.max(1, ...rows.map(row => parsePct(row[valueKey])));
    rows.forEach((row, idx) => {
      const yy = y + idx * rowH;
      const pct = parsePct(row[valueKey]);
      const labelW = w * 0.36;
      addText(slide, clean(row[labelKey], 42), x, yy, labelW, 0.18, { fontSize: 8.2, color: palette.ink, margin: 0 });
      addRect(slide, x + labelW + 0.1, yy + 0.03, w - labelW - 0.55, 0.1, palette.gray);
      addRect(slide, x + labelW + 0.1, yy + 0.03, Math.max(0.08, (w - labelW - 0.55) * (pct / max)), 0.1, accent);
      addText(slide, pct ? pct.toFixed(0) + '%' : '-', x + w - 0.36, yy - 0.01, 0.36, 0.16, { fontSize: 7.6, color: palette.muted, align: 'right', margin: 0 });
    });
  }

  function tableCell(text, opts = {}) {
    const options = {
      bold: !!opts.bold,
      color: opts.color || palette.ink,
      margin: opts.margin ?? 0.04,
      valign: 'top'
    };
    if (opts.fill) options.fill = { color: opts.fill };
    if (opts.fontSize) options.fontSize = Math.max(opts.fontSize, opts.minFontSize || 6.0);
    return {
      text: clean(text, opts.max || 120, ''),
      options
    };
  }

  function addTable(slide, columns, rows, x, y, w, h, colW, accent = palette.navy, opts = {}) {
    const tableFontSize = Math.max(opts.fontSize || 7.8, opts.minFontSize || 6.0);
    const headerFontSize = Math.max(opts.headerSize || 7.8, opts.headerMinFontSize || 6.2);
    const header = columns.map(col => tableCell(col, { bold: true, color: accent, fill: opts.headerFill || palette.gray, max: opts.headerMax || 38, fontSize: headerFontSize, margin: opts.margin }));
    const body = rows.map(row => row.map(cell => tableCell(cell, { max: opts.cellMax || 110, fontSize: tableFontSize, margin: opts.margin })));
    slide.addTable([header, ...body], {
      x, y, w, h,
      colW,
      border: { type: 'solid', color: palette.border, pt: 0.45 },
      fontFace: 'Aptos',
      fontSize: tableFontSize,
      color: palette.ink,
      valign: 'top',
      margin: 0.05
    });
  }

  function addTableSlides(section, title, columns, rows, colW, accent = palette.navy, rowsPerSlide = 6, opts = {}) {
    const safeRows = asArray(rows).filter(row => Array.isArray(row));
    if (!safeRows.length) return;
    chunk(safeRows, rowsPerSlide).forEach((part, idx) => {
      const slide = newSlide(section, idx ? title + ' (cont.)' : title, accent);
      const tableH = opts.tableHeight || Math.min(
        opts.maxTableHeight || 4.95,
        Math.max(opts.minTableHeight || 1.15, (opts.headerRowHeight || 0.38) + part.length * (opts.rowHeight || 0.44))
      );
      addTable(slide, columns, part, 0.62, 1.62, 12.1, tableH, colW, accent, opts);
    });
  }

  function drawCover() {
    const slide = pptx.addSlide();
    slideNo += 1;
    addBackground(slide);
    addRect(slide, 0, 0, W, 3.15, palette.navy);
    addRect(slide, 0, 3.15, W, 0.12, palette.orange);
    addRect(slide, 0.62, 0.6, 0.86, 0.05, palette.orange);
    addText(slide, 'RESPONDIQ', 0.62, 0.78, 2.4, 0.28, { fontSize: 17, color: palette.white, bold: true, margin: 0 });
    addText(slide, 'by', 0.62, 1.08, 0.55, 0.16, { fontSize: 7.8, color: 'CBD5E1', margin: 0 });
    addText(slide, 'Responsive MTS', 0.62, 1.25, 2.65, 0.2, { fontSize: 10.6, color: palette.white, bold: true, margin: 0 });
    addText(slide, campaign, 0.62, 1.72, 7.5, 0.72, { fontSize: campaign.length > 44 ? 28 : 34, color: palette.white, bold: true, margin: 0, max: 74 });
    addText(slide, 'Client-ready media strategy generated by the RespondIQ AI Engine', 0.62, 2.52, 6.4, 0.24, { fontSize: 12, color: 'E2E8F0', margin: 0 });
    addRect(slide, 0.62, 3.72, 12.1, 1.2, palette.white, palette.border);
    addRect(slide, 0.62, 3.72, 0.08, 1.2, palette.orange);
    addText(slide, 'Media Plan', 0.9, 4.02, 3.6, 0.35, { fontSize: 24, color: palette.ink, bold: true, margin: 0 });
    addText(slide, 'Prepared for ' + brand, 0.9, 4.48, 5.3, 0.2, { fontSize: 10, color: palette.muted, margin: 0 });
    addText(slide, 'Prepared ' + generatedAt, 8.35, 4.5, 3.9, 0.18, { fontSize: 9, color: palette.muted, align: 'right', margin: 0 });
    addMetric(slide, 0.62, 5.45, 3.75, 0.85, p.total_investment || money(totalBudget), 'Total investment', palette.navy);
    addMetric(slide, 4.8, 5.45, 3.75, 0.85, p.projected_impressions || '-', 'Projected impressions', palette.blue);
    addMetric(slide, 8.98, 5.45, 3.75, 0.85, primaryKpi || '-', isSalesGoal ? 'Target ROAS' : 'Primary KPI', palette.orange);
    addText(slide, 'Editable PowerPoint deck generated by RespondIQ.', 0.62, 7.08, 6.5, 0.18, { fontSize: 7, color: palette.muted, margin: 0 });
  }

  function drawSnapshot() {
    const slide = newSlide('Snapshot', campaign + ' at a Glance', palette.orange);
    addMetric(slide, 0.62, 1.68, 2.82, 0.82, p.total_investment || money(totalBudget), 'Total investment', palette.navy);
    addMetric(slide, 3.75, 1.68, 2.82, 0.82, p.projected_impressions || '-', 'Projected impressions', palette.blue);
    addMetric(slide, 6.88, 1.68, 2.82, 0.82, primaryKpi || '-', isSalesGoal ? 'Target ROAS' : 'Primary KPI', palette.orange);
    addMetric(slide, 10.0, 1.68, 2.72, 0.82, p.target_reach_pct || '-', 'Target reach', palette.teal);
    addPanel(slide, 0.62, 2.92, 5.55, 2.35, 'Campaign Profile',
      [
        'Client: ' + brand,
        'Duration: ' + textValue(d.campaignDuration),
        'Budget: ' + textValue(d.budget),
        'Goal: ' + textValue(d.goal),
        'Location: ' + textValue(d.location)
      ].join('\n'), palette.orange, { bodySize: 9.2, max: 420 });
    addPanel(slide, 6.45, 2.92, 6.27, 2.35, 'Recommended Channel Mix',
      asArray(p.budget_breakdown).length ? 'Budget allocation by channel based on objective, audience, and campaign duration.' : 'Channel mix will appear here after plan generation.',
      palette.blue, { bodySize: 9.2, max: 260 });
    addBars(slide, p.budget_breakdown, 'item', 'pct', 6.7, 3.62, 5.75, 0.23, palette.blue, 7);
  }

  function drawStrategy() {
    const slide = newSlide('Section 01', 'Executive Strategy', palette.navy);
    addPanel(slide, 0.62, 1.68, 5.85, 4.95, 'Executive Summary', p.executive_summary, palette.navy, { bodySize: 10.3, max: 720, minBodySize: 6.6 });
    addPanel(slide, 6.78, 1.68, 5.94, 2.72, 'Media Strategy', p.media_strategy, palette.blue, { bodySize: 8.4, max: 390, minBodySize: 6.2 });
    addPanel(slide, 6.78, 4.66, 5.94, 1.97, 'Recommended Next Steps', listText(p.recommendations, 4, 92), palette.orange, { bodySize: 7.3, max: 390, minBodySize: 6.0 });
  }

  function drawAudienceObjectives() {
    const audience = p.target_audience || {};
    const slide = newSlide('Sections 03-04', 'Audience and Objectives', palette.blue);
    addPanel(slide, 0.62, 1.68, 5.85, 1.38, 'Primary Audience', clean(audience.demographics, 220), palette.blue, { bodySize: 8.9, max: 250 });
    addPanel(slide, 0.62, 3.22, 5.85, 1.38, 'Behavioral Signals', clean(audience.behavioral, 220), palette.teal, { bodySize: 8.9, max: 250 });
    addPanel(slide, 0.62, 4.76, 5.85, 1.38, 'Geographic Focus', clean(audience.geographic, 220), palette.orange, { bodySize: 8.9, max: 250 });
    addPanel(slide, 6.78, 1.68, 5.94, 2.22, 'Marketing Objectives', listText(p.marketing_objectives, 5, 108), palette.blue, { bodySize: 8.4, max: 560 });
    addPanel(slide, 6.78, 4.08, 5.94, 2.22, 'Media Objectives', listText(p.media_objectives, 5, 108), palette.teal, { bodySize: 8.4, max: 560 });
  }

  function drawChannels() {
    const channels = asArray(p.channels);
    if (!channels.length) return;
    chunk(channels, 2).forEach((part, pageIdx) => {
      const slide = newSlide('Section 06', pageIdx ? 'Media Channel Mix (cont.)' : 'Media Channel Mix', palette.orange);
      part.forEach((ch, idx) => {
        const y = 1.68 + idx * 2.48;
        addPanel(slide, 0.62, y, 12.1, 2.22, clean(ch.name, 44) + ' - ' + clean(ch.budget_pct, 12), clean(ch.rationale, 220) + '\n' + listText(ch.tactics, 3, 120), palette.orange, { bodySize: 8.0, max: 620, minBodySize: 6.2 });
      });
    });
  }

  function drawBudgetAndKpis() {
    const slide = newSlide('Sections 08-09', 'Budget and Measurement', palette.teal);
    addPanel(slide, 0.62, 1.68, 5.2, 4.85, 'Budget Distribution', 'Budget allocation shown as percent of total media investment.', palette.orange, { bodySize: 8.6, max: 180 });
    addBars(slide, p.budget_breakdown, 'item', 'pct', 0.88, 2.38, 4.68, 0.26, palette.orange, 10);
    const kpiRows = asArray(p.kpis).slice(0, 6).map(k => [k.kpi, k.target, k.frequency]);
    if (kpiRows.length) {
      addTable(slide, ['KPI', 'Target', 'Cadence'], kpiRows, 6.12, 1.82, 6.6, 3.1, [2.35, 2.55, 1.7], palette.teal, { fontSize: 6.9, cellMax: 95, headerFill: 'E8F7F4' });
    }
    addPanel(slide, 6.12, 5.12, 6.6, 1.15, 'Reporting Plan', listText(p.reporting_plan, 3, 150), palette.teal, { bodySize: 7.5, max: 420 });
  }

  function drawCompetitive() {
    const sov = asArray(p.competitive_sov);
    const comps = asArray(p.competitors);
    if (!sov.length && !comps.length) return;
    const slide = newSlide('Section 12', 'Competitive Intelligence', palette.navy);
    addPanel(slide, 0.62, 1.68, 5.65, 4.9, 'Share of Voice', 'Directional competitive pressure across media channels. Spend and SOV estimates should be validated before final investment decisions.', palette.navy, { bodySize: 8.6, max: 320 });
    addBars(slide, sov, 'brand', 'sov_pct', 0.88, 2.56, 5.05, 0.3, palette.navy, 8);
    const compRows = comps.slice(0, 5).map(c => [c.name, c.market_share, c.strengths]);
    if (compRows.length) {
      addTable(slide, ['Competitor', 'Share', 'Key Strength'], compRows, 6.55, 1.82, 6.17, 3.2, [1.55, 1.0, 3.62], palette.navy, { fontSize: 6.7, cellMax: 90, headerFill: palette.gray });
    }
    addPanel(slide, 6.55, 5.28, 6.17, 1.05, 'Market Opportunities', listText(p.market_opportunities, 3, 150), palette.blue, { bodySize: 7.4, max: 420 });
  }

  function drawMeasurement() {
    const hasAttribution = asArray(p.attribution_models).length || asArray(p.analytics_stack).length || asArray(p.customer_journey).length;
    if (!hasAttribution) return;
    const slide = newSlide('Section 11', 'Attribution and Analytics Framework', palette.teal);
    const attrRows = asArray(p.attribution_models).slice(0, 5).map(a => [a.model, a.use_case, a.tool]);
    if (attrRows.length) {
      addTable(slide, ['Model', 'Use Case', 'Tool'], attrRows, 0.62, 1.72, 6.0, 3.0, [1.5, 3.0, 1.5], palette.teal, { fontSize: 6.8, cellMax: 90, headerFill: 'E8F7F4' });
    }
    addPanel(slide, 6.9, 1.72, 5.82, 2.0, 'Analytics Stack', listText(p.analytics_stack, 6, 100), palette.teal, { bodySize: 8, max: 520 });
    addPanel(slide, 0.62, 5.0, 12.1, 1.05, 'Journey Tracking', listText(asArray(p.customer_journey).map(j => [j.stage, j.touchpoints, j.metrics].filter(Boolean).join(': ')), 3, 180), palette.blue, { bodySize: 7.4, max: 560 });
  }

  function drawRisksCro() {
    const risks = asArray(p.risks);
    if (!risks.length && !p.cro_audit) return;
    const slide = newSlide('Sections 10 & 14', 'Risk and Conversion Readiness', palette.amber);
    const riskRows = risks.slice(0, 5).map(r => [r.risk, r.impact, r.probability, r.mitigation]);
    if (riskRows.length) {
      addTable(slide, ['Risk', 'Impact', 'Prob.', 'Mitigation'], riskRows, 0.62, 1.72, 12.1, 2.9, [3.0, 1.15, 1.15, 6.8], palette.amber, { fontSize: 6.2, cellMax: 100, headerFill: 'FFF7E8', margin: 0.035 });
    }
    if (p.cro_audit) {
      addPanel(slide, 0.62, 4.9, 2.75, 1.52, 'Landing Page Score', clean(p.cro_audit.landing_page_score, 20), palette.amber, { bodySize: 18, max: 20 });
      addPanel(slide, 3.62, 4.9, 4.35, 1.52, 'Missing Elements', listText(p.cro_audit.missing_elements, 3, 78), palette.amber, { bodySize: 6.4, max: 260, minBodySize: 5.8 });
      addPanel(slide, 8.22, 4.9, 4.5, 1.52, 'CRO Recommendations', listText(p.cro_audit.recommendations, 3, 78), palette.teal, { bodySize: 6.4, max: 260, minBodySize: 5.8 });
    }
  }

  function drawCreative() {
    const briefs = asArray(p.creative_briefs);
    if (!briefs.length) return;
    chunk(briefs, 2).forEach((part, pageIdx) => {
      const slide = newSlide('Section 15', pageIdx ? 'Creative Briefs (cont.)' : 'Creative Briefs', palette.amber);
      part.forEach((b, idx) => {
        const y = 1.68 + idx * 2.48;
        const headlines = asArray(b.headline_direction).length ? asArray(b.headline_direction).join('; ') : textValue(b.headline_direction, '');
        addPanel(slide, 0.62, y, 12.1, 2.22, clean(b.channel, 44), [
          'Format: ' + clean(b.format, 80),
          'Headline: ' + clean(headlines, 120),
          'CTA: ' + clean(b.cta, 60),
          'Notes: ' + clean(b.creative_notes, 130)
        ].join('\n'), palette.amber, { bodySize: 7.8, max: 560, minBodySize: 6.1 });
      });
    });
  }

  function drawBenchmarks() {
    const rows = asArray(p.benchmarks).map(b => [b.metric, b.plan_target, b.industry_avg, b.vs_benchmark]);
    addTableSlides('Section 16', 'Industry Benchmark Comparison', ['Metric', 'Plan Target', 'Industry Avg', 'vs. Benchmark'], rows, [2.8, 2.2, 2.8, 4.3], palette.teal, 10, { fontSize: 6.3, headerSize: 6.7, cellMax: 115, headerFill: 'E9F4FF', rowHeight: 0.33, headerRowHeight: 0.34, maxTableHeight: 4.6 });
  }

  function drawKeywords() {
    const rows = asArray(p._keywordResults).slice(0, 10).map(kw => [
      kw.keyword,
      kw.avg_monthly_searches,
      kw.competition,
      [kw.low_cpc, kw.high_cpc].filter(Boolean).join(' - ') || 'N/A'
    ]);
    addTableSlides('Section 17', 'Search Keyword Recommendations', ['Keyword', 'Avg. Monthly Searches', 'Competition', 'Est. CPC Range'], rows, [4.35, 2.55, 1.85, 3.35], palette.navy, 10, { fontSize: 6.1, headerSize: 6.5, cellMax: 115, headerMax: 44, rowHeight: 0.32, headerRowHeight: 0.34, maxTableHeight: 4.55 });
  }

  function drawFlightPlan() {
    const flight = inferFlightColumns(d.campaignDuration);
    const rows = asArray(p.flight_plan).map(fp => [fp.channel, ...flight.keys.map(k => fp[k] || '-')]);
    addTableSlides('Section 07', 'Flight Plan and Calendar', ['Channel', ...flight.headers], rows, [1.65, 2.6, 2.6, 2.6, 2.65], palette.orange, 4, { fontSize: 5.45, headerSize: 6.1, cellMax: 260, headerMax: 44, headerFill: 'FFF1EB', tableHeight: 5.3, margin: 0.035 });
  }

  function drawRecommendations() {
    const slide = newSlide('Section 13', 'Recommendations and Next Steps', palette.navy);
    addPanel(slide, 0.62, 1.72, 6.0, 4.75, 'Priority Actions', listText(p.recommendations, 6, 125), palette.navy, { bodySize: 8.4, max: 760, minBodySize: 6.2 });
    addPanel(slide, 6.9, 1.72, 5.82, 2.25, 'Campaign Governance', listText(p.monitoring_tools && asArray(p.monitoring_tools).map(m => [m.tool, m.frequency, m.trigger].filter(Boolean).join(' - ')), 4, 105), palette.blue, { bodySize: 7.4, max: 460, minBodySize: 6.0 });
    addPanel(slide, 6.9, 4.25, 5.82, 2.22, 'Important Notice', 'AI-generated media plans should be treated as strategic starting points. Validate budget allocations, rates, audience estimates, and competitive figures in platform tools before committing spend.', palette.orange, { bodySize: 7.6, max: 390, minBodySize: 6.0 });
  }

  function drawClosing() {
    const slide = pptx.addSlide();
    slideNo += 1;
    addBackground(slide);
    addRect(slide, 0, 0, W, 2.0, palette.navy);
    addRect(slide, 0, 2.0, W, 0.1, palette.orange);
    addText(slide, 'RESPONDIQ', 0.62, 0.64, 12.1, 0.28, { fontSize: 18, color: palette.white, bold: true, align: 'center', margin: 0 });
    addText(slide, 'by', 0.62, 0.98, 12.1, 0.16, { fontSize: 7.8, color: 'CBD5E1', align: 'center', margin: 0 });
    addText(slide, 'Responsive MTS', 0.62, 1.17, 12.1, 0.22, { fontSize: 11, color: palette.white, bold: true, align: 'center', margin: 0 });
    addText(slide, 'Thank You', 0.62, 3.05, 12.1, 0.58, { fontSize: 36, color: palette.ink, bold: true, align: 'center', margin: 0 });
    addText(slide, 'Prepared for ' + brand, 0.62, 3.78, 12.1, 0.25, { fontSize: 12, color: palette.muted, align: 'center', margin: 0 });
    addRect(slide, 4.0, 4.62, 5.33, 0.9, 'FFF7ED', 'FFD7C2');
    addText(slide, 'NEED DEEPER STRATEGY OR FULL-SERVICE EXECUTION?', 4.12, 4.84, 5.1, 0.16, { fontSize: 7.5, color: palette.navy, bold: true, align: 'center', margin: 0 });
    addText(slide, 'info@responsivemts.com', 4.12, 5.12, 5.1, 0.2, { fontSize: 12, color: palette.orange, bold: true, align: 'center', margin: 0 });
  }

  drawCover();
  drawSnapshot();
  drawStrategy();
  drawAudienceObjectives();
  drawChannels();
  drawFlightPlan();
  drawBudgetAndKpis();
  drawCompetitive();
  drawMeasurement();
  drawRisksCro();
  drawCreative();
  drawBenchmarks();
  drawKeywords();
  drawRecommendations();
  drawClosing();

  const output = await pptx.write({ outputType: 'nodebuffer', compression: true });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

app.post('/api/export-pptx', async (req, res) => {
  try {
    const data = req.body && req.body.form_data;
    const plan = req.body && req.body.plan;
    if (!data || !plan) {
      return res.status(400).json({ error: 'form_data and plan are required' });
    }

    const pptx = await createRespondIqPptxBuffer(data, plan);
    const filename = downloadFilename(data.campaignName || data.brandName || 'media-plan') + '.pptx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-Length', pptx.length);
    res.send(pptx);
  } catch (err) {
    if (err.code === 'PPTXGEN_MISSING') {
      console.error('[RespondIQ] PPT export dependency missing:', err.message);
      return res.status(501).json({ error: 'PPT export dependency is not installed. Run npm install before using server-side PPT export.' });
    }
    console.error('[RespondIQ] PPT export error:', err.message);
    res.status(500).json({ error: 'PPT export failed: ' + err.message });
  }
});






// ══════════════════════════════════════════════════════════════
// HELPER: Call Gemini 3.1 Pro with Medium thinking + Search grounding
// Uses the new @google/genai SDK (required for Gemini 3.x models)
// Returns the response text string
// ══════════════════════════════════════════════════════════════
async function callGemini(systemInstruction, history, userMessage, opts = {}) {
  const ai = getGeminiClient();

  // Build contents array: history + new user message
  const contents = [
    ...history.map(m => ({
      role: m.role,
      parts: [{ text: m.parts[0].text }]
    })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  console.log('[RespondIQ] Calling Gemini 3.1 Pro (MEDIUM thinking + Search grounding)');

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: contents,
    config: {
      systemInstruction: systemInstruction,
      // Google Search grounding: verifies benchmarks + competitors against live data
      tools: [{ googleSearch: {} }],
      // NOTE: Do NOT set temperature on Gemini 3 thinking models
      maxOutputTokens: opts.maxOutputTokens || 8192,
      thinkingConfig: {
        thinkingLevel: 'medium'
      }
    }
  });

  return response.text;
}


// ══════════════════════════════════════════════════════════════
// INDUSTRY DETECTION: Verify the form-submitted industry against
// actual brand identity (website content + brand name analysis).
// Runs BEFORE competitor identification and benchmark injection
// so the entire pipeline uses the correct industry from the start.
// ══════════════════════════════════════════════════════════════
async function detectActualIndustry(brandName, formIndustry, websiteText) {
  try {
    const ai = getGeminiClient();

    // Build the list of valid benchmark industries for the model to choose from
    const validIndustries = Object.entries(BENCHMARKS)
      .filter(([k]) => k !== 'default')
      .map(([k, v]) => `  "${k}" = ${v.label}`)
      .join('\n');

    const validKeys = Object.keys(BENCHMARKS);

    const prompt = `Classify the brand "${brandName}" into an industry.
User selected: "${formIndustry}"
${websiteText ? `Website excerpt: ${websiteText.substring(0, 1500)}` : 'No website content. Use brand name and your knowledge.'}

VALID KEYS:
${validIndustries}
  "default" = General / Cross-Industry

Classification rules:
- Car wash, auto repair, dealership = "automotive"
- Local services (plumber, HVAC) = "home_services"
- If user selected no industry, this is an auto-detect request. Choose the best valid key from the brand/website and return corrected=false
- If a non-empty user selection is correct, return that key with corrected=false
- If a non-empty user selection is wrong, return the correct key with corrected=true

Respond with ONLY the JSON object. No explanation, no markdown.`;

    console.log('[RespondIQ] Detecting actual industry for:', brandName, '| form said:', formIndustry);

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 512,                       // defensive headroom for schema output
        thinkingConfig: { thinkingLevel: 'low' },   // Gemini 3.1 Pro requires thinking mode
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            industry_key: { type: 'string' },
            industry_label: { type: 'string' },
            corrected: { type: 'boolean' },
            reason: { type: 'string' }
          },
          required: ['industry_key', 'industry_label', 'corrected', 'reason']
        }
        // NOTE: No googleSearch tool. Classification does not need live search.
      }
    });

    const text = response.text || '';
    // Robust JSON extraction: handles markdown fences, preamble text, partial responses
    const result = extractJSONFromLLM(text, 'object');
    if (result && result.industry_key && BENCHMARKS[result.industry_key]) {
      const detectionLabel = result.corrected
        ? `CORRECTED "${formIndustry}" -> "${result.industry_label}"`
        : formIndustry
          ? `CONFIRMED "${formIndustry}"`
          : `AUTO-DETECTED "${result.industry_label}"`;
      console.log('[RespondIQ] Industry detection result:',
        detectionLabel,
        '| reason:', result.reason || 'n/a');
      return {
        key: result.industry_key,
        label: result.industry_label || BENCHMARKS[result.industry_key].label,
        corrected: !!result.corrected,
        reason: result.reason || '',
        formIndustry: formIndustry,
        autoDetected: !formIndustry,
      };
    }

    console.warn('[RespondIQ] Industry detection: could not parse response, using form value. Raw:', text.substring(0, 300));
    return null;
  } catch (err) {
    console.warn('[RespondIQ] Industry detection failed (graceful):', err.message);
    return null;
  }
}


// ══════════════════════════════════════════════════════════════
// AUTO-TRIGGER: Identify competitors via lightweight Gemini call
// Used when user leaves competitors field blank
// ══════════════════════════════════════════════════════════════
async function identifyCompetitors(brandName, industry, companySize, websiteText) {
  try {
    const ai = getGeminiClient();
    const prompt = `Identify 3-5 REAL companies that directly compete with "${brandName}" in the ${industry} industry.

Rules:
- ${brandName} is a ${companySize} company. Match competitors by SIMILAR size.
- Do NOT pick Fortune 500 giants unless ${brandName} is also a large enterprise.
- Every name must be a real, existing company (not fictional).
- Pick companies that ${brandName} would actually compete against for the same customers.
${websiteText ? `\nWebsite context:\n${websiteText.substring(0, 1500)}` : ''}

Respond with ONLY a JSON array of company name strings. No explanation, no markdown, no numbered lists.`;

    console.log('[RespondIQ] Auto-identifying competitors for:', brandName);

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 1024,                     // headroom for 3-5 names
        thinkingConfig: { thinkingLevel: 'low' },  // Gemini 3.1 Pro requires thinking mode
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    });

    const text = response.text || '';

    // Primary: Robust JSON array extraction (handles fences, preamble, nested brackets)
    const parsed = extractJSONFromLLM(text, 'array');
    if (Array.isArray(parsed) && parsed.length > 0) {
      const names = parsed.filter(n => typeof n === 'string' && n.trim().length > 0).slice(0, 5);
      if (names.length > 0) {
        console.log('[RespondIQ] Auto-identified competitors:', names.join(', '));
        return names;
      }
    }

    // Fallback: Conversational parser for numbered lists or prose
    const numberedListNames = [];
    const numberedRegex = /^\s*\d+[\.\)]\s*\*{0,2}(.+?)(?:\*{0,2})\s*(?:[:\-].*)?$/gm;
    let listMatch;
    while ((listMatch = numberedRegex.exec(text)) !== null) {
      const name = listMatch[1].replace(/\*+/g, '').replace(/["']/g, '').trim();
      if (name.length > 1 && name.length < 80) {
        numberedListNames.push(name);
      }
    }

    if (numberedListNames.length >= 2) {
      const recovered = numberedListNames.slice(0, 5);
      console.log('[RespondIQ] Auto-identified competitors (conversational fallback):', recovered.join(', '));
      return recovered;
    }

    // Last-resort fallback: split on common separators and clean each token.
    // Even if Gemini returns '[ "Goodway Group", "Theorem' (truncated, broken JSON),
    // we can still recover ["Goodway Group"] as one usable name. Better one verified
    // competitor than zero. (Reached only if both prior parsers above returned/skipped.)
    const fallbackSource = text.includes('[') ? text.substring(text.indexOf('[')) : text;
    const tokens = fallbackSource
      .replace(/^\s*[\[\]"`]+|[\[\]"`]+\s*$/g, '')   // strip JSON brackets/quotes at edges
      .split(/[,\n\r]+/)
      .map(t => t.replace(/^[\s"'\-•*\d\.\)]+|[\s"'\.,;]+$/g, '').trim())
      .filter(t => t.length >= 2 && t.length <= 80 && !/^[\d\.]+$/.test(t))
      .filter(t => !/^(here|json|company|companies|competitors?|requested|response)\b/i.test(t));
    const uniqueTokens = [...new Set(tokens)];
    if (uniqueTokens.length >= 1) {
      const recovered = uniqueTokens.slice(0, 5);
      console.log('[RespondIQ] Auto-identified competitors (split fallback):', recovered.join(', '));
      return recovered;
    }

    console.warn('[RespondIQ] Could not parse competitor names from:', text.substring(0, 300));
    return [];
  } catch (err) {
    console.warn('[RespondIQ] identifyCompetitors failed (graceful):', err.message);
    return [];
  }
}


// ══════════════════════════════════════════════════════════════
// MAIN ENDPOINT: /generate-plan
// Handles both initial generation AND plan refinement
// ══════════════════════════════════════════════════════════════
app.post('/generate-plan', async (req, res) => {
  try {
    // Validate GEMINI_API_KEY early
    if (!process.env.GEMINI_API_KEY) {
      console.error('[RespondIQ] GEMINI_API_KEY not set');
      return res.status(500).json({ error: 'API key not configured. Set GEMINI_API_KEY in Render > Environment.' });
    }

    const requestBody = req.body;

    // ── REFINE PLAN: User has an existing plan and wants changes ──
    if (requestBody.refine_instruction && requestBody.current_plan) {
      const safeRefineInstruction = redactKnownPersonalText(String(requestBody.refine_instruction || ''));
      const safeCurrentPlan = redactKnownPersonalData(requestBody.current_plan || {});
      console.log('[RespondIQ] Refine request:', safeRefineInstruction.substring(0, 80));

      const refineSystem = `You are a senior media strategist. The user has an existing media plan (JSON) and wants changes.
Return the FULL updated JSON plan (not a partial diff).
Maintain valid math: all budget_pct must sum to 100%, impressions must recalculate from budget changes, and all fields must remain populated.
Return ONLY valid JSON, no markdown, no code fences, no explanation text.`;

      const refineUser = `Here is the current media plan JSON:\n\n${JSON.stringify(safeCurrentPlan)}\n\nThe user wants the following change:\n"${safeRefineInstruction}"\n\nReturn the FULL updated JSON plan with this change applied. Recalculate all affected numbers (budget splits, impressions, KPIs) to maintain mathematical consistency. Return ONLY the JSON object.`;

      try {
        const refineText = await callGemini(refineSystem, [], refineUser, { maxOutputTokens: 8192 });
        console.log('[RespondIQ] Refine complete, chars:', refineText.length);

        return res.json({
          choices: [{ message: { content: refineText } }]
        });
      } catch (err) {
        console.error('[RespondIQ] Refine error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── PRIORITY 2: Accept clean form_data from frontend (prompt built server-side) ──
    const data = stripPersonalFieldsForAI(requestBody.form_data || {});
    if (!data || !data.brandName) {
      return res.status(400).json({ error: 'Invalid request: form_data with brandName required' });
    }

    // Parse budget and duration
    const bInfo = BUDGET_MAP[data.budget] || BUDGET_MAP['$10,000 - $25,000'];
    const months = DURATION_MONTHS[data.campaignDuration] || 3;
    const totalBudgetLow = bInfo.low * months;
    const totalBudgetHigh = bInfo.high * months;
    const totalBudgetMid = bInfo.mid * months;

    // Accept keyword data and competitor intel passed from frontend data-fetch calls
    const keywordData = requestBody.keyword_data || null;
    let frontendCompetitorIntelBlock = requestBody.competitor_intel_block || '';
    const frontendCompetitorIntelResults = Array.isArray(requestBody.competitor_intel_results)
      ? requestBody.competitor_intel_results
      : [];
    const frontendMetaAdsResults = Array.isArray(requestBody.meta_ads_intel_results)
      ? requestBody.meta_ads_intel_results
      : [];

    // ── WEBSITE INTELLIGENCE: Scrape client site for real business context ──
    let websiteIntel = { text: '', techStack: [], socialLinks: [] };
    const siteUrl = data.website || '';
    if (siteUrl && siteUrl !== 'N/A' && siteUrl.length > 3) {
      try {
        websiteIntel = await scrapeWebsite(siteUrl);
        console.log('[RespondIQ] Scraped:', siteUrl,
          '| chars:', websiteIntel.text.length,
          '| Tech:', websiteIntel.techStack.join(', ') || 'None',
          '| Social:', websiteIntel.socialLinks.join(', ') || 'None');
      } catch (err) {
        console.warn('[RespondIQ] Scrape failed:', err.message);
      }
    }

    // ── INDUSTRY VERIFICATION: Detect actual industry BEFORE pipeline steps ──
    let industryOverride = null;
    const formIndustry = data.industry || '';

    const shouldDetectIndustry = !!data.brandName;
    if (shouldDetectIndustry) {
      industryOverride = await detectActualIndustry(data.brandName, formIndustry, websiteIntel.text);
    }

    const industryWasAutoDetected = !!(industryOverride && !formIndustry);
    const effectiveIndustry = (industryOverride && (industryOverride.corrected || industryWasAutoDetected))
      ? industryOverride.label
      : formIndustry;
    const effectiveIndustryKey = (industryOverride && (industryOverride.corrected || industryWasAutoDetected))
      ? industryOverride.key
      : null;

    if (industryOverride && industryOverride.corrected) {
      console.log('[RespondIQ] Industry CORRECTED:', formIndustry, '->', effectiveIndustry, '(key:', industryOverride.key + ')');
    }

    // ── AUTO-TRIGGER: Competitive Intelligence via verified ad libraries ──
    let competitiveIntelResults = frontendCompetitorIntelResults;
    let metaAdsResults = frontendMetaAdsResults;
    let competitiveIntelBlock = frontendCompetitorIntelBlock;

    if (!data.competitors) {
      try {
        const industry = effectiveIndustry;
        const companySize = data.companySize || '';

        console.log('[RespondIQ] Auto-trigger competitive intel for:', data.brandName, '|', industry, '|', companySize);

        const identifiedNames = await identifyCompetitors(data.brandName, industry, companySize, websiteIntel.text);

        if (identifiedNames.length > 0) {
          const targetLocations = data.locationList && data.locationList.length ? data.locationList : data.location;
          const [googleIntel, metaIntel] = await Promise.all([
            getCompetitiveIntelligence(identifiedNames, targetLocations),
            getMetaAdsIntelligence(identifiedNames, targetLocations),
          ]);
          competitiveIntelResults = googleIntel || [];
          metaAdsResults = metaIntel || [];

          const googlePromptBlock = buildCompetitorPromptBlock(competitiveIntelResults);
          const metaAdsPromptBlock = buildMetaAdsPromptBlock(metaAdsResults);
          competitiveIntelBlock = [googlePromptBlock, metaAdsPromptBlock].filter(Boolean).join('\n\n');

          const foundCount = competitiveIntelResults.filter(r => r.found).length;
          const metaFoundCount = metaAdsResults.filter(r => r.found).length;
          console.log('[RespondIQ] Auto-trigger result:', foundCount, 'of', identifiedNames.length, 'found in Transparency Center |', metaFoundCount, 'found in Meta Ad Library');
        } else {
          console.log('[RespondIQ] Auto-trigger: no competitors identified, skipping Transparency lookup');
        }
      } catch (err) {
        console.warn('[RespondIQ] Auto-trigger competitive intel failed (graceful):', err.message);
      }
    }

    if (data.competitors && metaAdsResults.length > 0 && !competitiveIntelBlock.includes('RULE 18')) {
      const metaAdsPromptBlock = buildMetaAdsPromptBlock(metaAdsResults);
      competitiveIntelBlock = [competitiveIntelBlock, metaAdsPromptBlock].filter(Boolean).join('\n\n');
    }

    // ── BUILD PROMPTS SERVER-SIDE (Priority 2) ──
    const promptData = {
      ...data,
      industry: effectiveIndustry || formIndustry || 'General / Cross-Industry'
    };
    const planningSignals = buildPlanningSignals(promptData, competitiveIntelResults, metaAdsResults);
    const systemInstruction = buildSystemPrompt(promptData);
    let userPrompt = buildUserPrompt(promptData, bInfo, months, totalBudgetLow, totalBudgetHigh, totalBudgetMid, keywordData, competitiveIntelBlock);

    // ── Inject Website Intelligence into user prompt ──
    if (websiteIntel.ssrfBlocked) {
      // SSRF-blocked URL: do NOT pass the URL or any reference to the blocked endpoint to the AI
      userPrompt += '\n\nWEBSITE NOTE: The provided website URL could not be accessed (connection refused or unreachable). Generate the plan using only the form data and your industry knowledge. Do NOT reference the specific URL in the plan output.';
    } else if (websiteIntel.text || websiteIntel.techStack.length || websiteIntel.socialLinks.length) {
      let intel = '\n\n=== WEBSITE INTELLIGENCE (scraped from ' + siteUrl + ') ===\n';
      intel += 'Below is ACTUAL content from the client website. Use this to:\n';
      intel += '1. Understand what the brand ACTUALLY does\n';
      intel += '2. Identify REAL competitive peers matched by service type AND company scale\n';
      intel += '3. Do NOT pick Fortune 500 companies unless the client is Fortune 500\n\n';

      if (websiteIntel.socialLinks.length) {
        intel += 'SOCIAL PRESENCE DETECTED: ' + websiteIntel.socialLinks.join(', ') + '\n';
        intel += 'Use this to inform channel selection, prioritize platforms where the brand already has a presence.\n';
      } else {
        intel += 'SOCIAL PRESENCE: No social media links found on the website.\n';
      }

      intel += '\n' + websiteIntel.text;
      userPrompt += intel;
    }

    // ── LAYER 1: Inject benchmark anchors ──
    const industryForBenchmark = effectiveIndustryKey
      ? BENCHMARKS[effectiveIndustryKey].label
      : (data.industry || '');
    const benchmarkBlock = buildBenchmarkPromptBlock(industryForBenchmark);
    userPrompt += '\n\n' + benchmarkBlock;
    console.log('[RespondIQ] Benchmark anchors injected | industry:', industryForBenchmark || '(default fallback)',
      industryOverride && industryOverride.corrected ? '(CORRECTED from ' + formIndustry + ')' : '');

    const planningSignalsBlock = buildPlanningSignalsPromptBlock(planningSignals);
    if (planningSignalsBlock) {
      userPrompt += '\n\n' + planningSignalsBlock;
      console.log('[RespondIQ] Planning signals injected | calibration:',
        planningSignals?.campaign_calibration?.modeled_target || 'none',
        '| pressure:', planningSignals?.competitive_pressure?.label || 'none');
    }

    // ── Inject industry correction notice into prompt (if corrected) ──
    if (industryOverride && industryOverride.corrected) {
      userPrompt += '\n\nINDUSTRY CORRECTION APPLIED: The user selected "' + formIndustry +
        '" but pre-analysis detected this brand operates in "' + effectiveIndustry + '". ' +
        'The benchmark anchors and competitor identification in this prompt ALREADY use ' + effectiveIndustry + ' data. ' +
        'Set industry_mismatch to true and detected_industry to "' + effectiveIndustry + '" in your JSON output.';
    } else if (industryWasAutoDetected) {
      userPrompt += '\n\nINDUSTRY AUTO-DETECTION APPLIED: The user selected auto-detect, and pre-analysis classified this brand as "' +
        effectiveIndustry + '". The benchmark anchors and competitor identification in this prompt ALREADY use ' +
        effectiveIndustry + ' data. Set industry_mismatch to false and detected_industry to "' +
        effectiveIndustry + '" in your JSON output.';
    }

    // ── Call Gemini ──
    const responseText = await callGemini(systemInstruction, [], userPrompt, {
      maxOutputTokens: 8192
    });

    console.log('[RespondIQ] Gemini response received, chars:', responseText.length);

    // ── Wrap response in OpenAI-compatible shape ──
    const result = {
      choices: [{ message: { content: responseText } }]
    };

    if (websiteIntel.techStack.length || websiteIntel.socialLinks.length) {
      result._website_intel = {
        tech_stack: websiteIntel.techStack,
        social_links: websiteIntel.socialLinks
      };
    }

    if (competitiveIntelResults.length > 0) {
      result._competitive_intel = competitiveIntelResults;
    }

    if (metaAdsResults.length > 0) {
      result.meta_ads_intel = metaAdsResults;
    }

    if (planningSignals) {
      result._planning_signals = planningSignals;
    }

    if (industryOverride && (industryOverride.corrected || industryWasAutoDetected)) {
      result._industry_override = {
        form_industry: industryOverride.formIndustry,
        detected_industry: industryOverride.label,
        detected_key: industryOverride.key,
        reason: industryOverride.reason,
        auto_detected: industryWasAutoDetected,
      };
    }

    // ── Surface benchmark sources used for this plan ──
    try {
      const benchmarkKey = effectiveIndustryKey || resolveIndustryKey(effectiveIndustry || data.industry || '');
      const industryEntry = BENCHMARKS[benchmarkKey];
      if (industryEntry && Array.isArray(industryEntry._sources) && industryEntry._sources.length > 0) {
        result._benchmark_sources = industryEntry._sources
          .map(sid => {
            const s = BENCHMARK_SOURCES[sid];
            if (!s) return null;
            return {
              id: sid,
              short_name: s.short_name,
              publisher: s.publisher,
              label: s.label,
              url: s.url,
              period: s.period,
              tier: s.tier,
              confidence: s.confidence
            };
          })
          .filter(Boolean);
        result._benchmark_industry_key = benchmarkKey;
        result._benchmark_industry_label = industryEntry.label;
      }
    } catch (e) {
      console.warn('[RespondIQ] Could not attach benchmark sources:', e.message);
    }

    res.json(result);

  } catch (err) {
    console.error('[RespondIQ] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// UPGRADE 1: AdTech-Aware Website Scraper
// Detects marketing pixels, social links, and extracts content
// ══════════════════════════════════════════════════════════════
async function scrapeWebsite(url) {
  if (!url.startsWith('http')) url = 'https://' + url;

  const homepageResult = await fetchPage(url);
  let about = { text: '', techStack: [], socialLinks: [] };
  let services = { text: '', techStack: [], socialLinks: [] };

  try {
    const base = new URL(url).origin;
    for (const p of ['/about', '/about-us', '/who-we-are', '/company']) {
      try {
        const t = await fetchPage(base + p);
        if (t && t.text.length > 100) { about = t; break; }
      } catch(e) {}
    }
    for (const p of ['/services', '/what-we-do', '/solutions', '/offerings']) {
      try {
        const t = await fetchPage(base + p);
        if (t && t.text.length > 100) { services = t; break; }
      } catch(e) {}
    }
  } catch(e) {}

  let fullText = '';
  if (homepageResult.text) fullText += 'HOMEPAGE:\n' + homepageResult.text + '\n\n';
  if (about.text) fullText += 'ABOUT:\n' + about.text + '\n\n';
  if (services.text) fullText += 'SERVICES:\n' + services.text + '\n\n';

  const allTech = [...new Set([...homepageResult.techStack, ...about.techStack, ...services.techStack])];
  const allSocial = [...new Set([...homepageResult.socialLinks, ...about.socialLinks, ...services.socialLinks])];

  return {
    text: fullText.length > 3500 ? fullText.substring(0, 3500) + '...' : fullText,
    techStack: allTech,
    socialLinks: allSocial,
    ssrfBlocked: !!homepageResult.ssrfBlocked
  };
}

async function fetchValidatedUrl(url, fetchOptions = {}, maxRedirects = 3) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const validation = await validateUrl(currentUrl);
    if (!validation.valid) {
      return { blocked: true, url: currentUrl, reason: validation.reason };
    }

    const response = await fetch(validation.url, {
      ...fetchOptions,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: validation.url };
      try {
        currentUrl = new URL(location, validation.url).href;
        continue;
      } catch {
        return { blocked: true, url: location, reason: 'Invalid redirect URL' };
      }
    }

    return { response, finalUrl: validation.url };
  }

  return { blocked: true, url: currentUrl, reason: 'Too many redirects' };
}

async function fetchPage(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const fetched = await fetchValidatedUrl(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RespondIQ/2.0)', 'Accept': 'text/html' }
    });
    clearTimeout(timer);

    if (fetched.blocked) {
      console.warn('[RespondIQ] fetchPage blocked (SSRF):', fetched.url, '|', fetched.reason);
      return { text: '', techStack: [], socialLinks: [], ssrfBlocked: true };
    }

    const r = fetched.response;
    if (!r.ok) return { text: '', techStack: [], socialLinks: [] };

    const html = await r.text();

    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) || [])[1] || '';

    // Pixel / Tag Detection
    const techStack = [];
    if (/fbevents\.js|fbq\s*\(/i.test(html)) techStack.push('Meta Pixel (Facebook)');
    if (/googletagmanager\.com\/gtm\.js/i.test(html)) techStack.push('Google Tag Manager (GTM)');
    if (/gtag\/js|googletagmanager\.com\/gtag/i.test(html)) techStack.push('Google Analytics 4 (GA4)');
    if (/snap\.licdn\.com|linkedin\.com\/insight/i.test(html)) techStack.push('LinkedIn Insight Tag');
    if (/analytics\.tiktok\.com/i.test(html)) techStack.push('TikTok Pixel');
    if (/googleadservices\.com\/pagead\/conversion/i.test(html)) techStack.push('Google Ads Conversion Tag');
    if (/js\.hs-scripts\.com|js\.hubspot\.com/i.test(html)) techStack.push('HubSpot Tracking');
    if (/static\.hotjar\.com/i.test(html)) techStack.push('Hotjar (Heatmaps)');
    if (/cdn\.segment\.com/i.test(html)) techStack.push('Segment Analytics');
    if (/widget\.intercom\.io/i.test(html)) techStack.push('Intercom');
    if (/js\.driftt\.com/i.test(html)) techStack.push('Drift Chat');
    if (/clarity\.ms/i.test(html)) techStack.push('Microsoft Clarity');
    if (/pintrk\s*\(|s\.pinimg\.com\/ct\/core\.js/i.test(html)) techStack.push('Pinterest Tag');
    if (/sc-static\.net\/scevent\.min\.js/i.test(html)) techStack.push('Snapchat Pixel');
    if (/static\.ads-twitter\.com/i.test(html)) techStack.push('X (Twitter) Pixel');

    // Social Link Discovery
    const socialLinks = [];
    const socialPatterns = [
      { regex: /href=["'](https?:\/\/(www\.)?facebook\.com\/[^"'\s>]+)["']/gi, name: 'Facebook' },
      { regex: /href=["'](https?:\/\/(www\.)?instagram\.com\/[^"'\s>]+)["']/gi, name: 'Instagram' },
      { regex: /href=["'](https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[^"'\s>]+)["']/gi, name: 'LinkedIn' },
      { regex: /href=["'](https?:\/\/(www\.)?tiktok\.com\/@[^"'\s>]+)["']/gi, name: 'TikTok' },
      { regex: /href=["'](https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|@)[^"'\s>]+)["']/gi, name: 'YouTube' },
      { regex: /href=["'](https?:\/\/(www\.)?(twitter|x)\.com\/[^"'\s>]+)["']/gi, name: 'X (Twitter)' },
      { regex: /href=["'](https?:\/\/(www\.)?pinterest\.com\/[^"'\s>]+)["']/gi, name: 'Pinterest' }
    ];
    for (const sp of socialPatterns) {
      if (html.match(sp.regex)) socialLinks.push(sp.name);
    }

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let out = '';
    if (title) out += 'Title: ' + title + '\n';
    if (desc) out += 'Description: ' + desc + '\n';
    if (text) out += 'Content: ' + text.substring(0, 2000);

    return { text: out, techStack, socialLinks };
  } catch(e) {
    clearTimeout(timer);
    return { text: '', techStack: [], socialLinks: [] };
  }
}


// ══════════════════════════════════════════════════════════════
// COMPETITIVE INTEL: /api/competitive-intel
// Returns real competitor ad data from Google Transparency + Meta Ad Library
// ══════════════════════════════════════════════════════════════
app.post('/api/competitive-intel', async (req, res) => {
  try {
    const { competitors, locations, location } = req.body;

    if (!competitors || !Array.isArray(competitors) || competitors.length === 0) {
      return res.json({ results: [], fallback: true, reason: 'no_competitors' });
    }

    // Cap at 8 competitors to keep response time reasonable
    const capped = competitors.slice(0, 8);
    const targetLocations = Array.isArray(locations) && locations.length ? locations : (location || ['United States']);
    console.log('[RespondIQ] Competitive intel request for:', capped.join(', '), '| locations:', Array.isArray(targetLocations) ? targetLocations.join(', ') : targetLocations);

    const [results, metaAdsResults] = await Promise.all([
      getCompetitiveIntelligence(capped, targetLocations),
      getMetaAdsIntelligence(capped, targetLocations),
    ]);
    const promptBlock = [
      buildCompetitorPromptBlock(results),
      buildMetaAdsPromptBlock(metaAdsResults)
    ].filter(Boolean).join('\n\n');

    const found = results ? results.filter(r => r.found) : [];
    const metaFound = metaAdsResults ? metaAdsResults.filter(r => r.found) : [];
    console.log('[RespondIQ] Competitive intel:', found.length, 'of', capped.length, 'found | Meta:', metaFound.length, 'found');

    res.json({
      results: results || [],
      meta_ads_intel: metaAdsResults || [],
      prompt_block: promptBlock,
      fallback: found.length === 0 && metaFound.length === 0,
      reason: found.length === 0 && metaFound.length === 0 ? 'no_matches_found' : null,
    });

  } catch (err) {
    console.error('[RespondIQ] Competitive intel error:', err.message);
    // Graceful fallback: never break the plan generation flow
    res.json({ results: [], prompt_block: '', fallback: true, reason: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// GOOGLE ADS KEYWORD PLANNER: /api/keyword-ideas
// Returns real search volume, competition, and CPC bid data.
// keyword-service.js now handles dual-call URL-based discovery:
//   Call 1: keywordAndUrlSeed (brand + URL) for branded terms
//   Call 2: urlSeed (URL only) for Google's content-based analysis
// ══════════════════════════════════════════════════════════════
app.post('/api/keyword-ideas', async (req, res) => {
  try {
    if (!isKeywordServiceConfigured()) {
      console.warn('[RespondIQ] Keyword service not configured, returning fallback');
      return res.json({ keywords: [], fallback: true, reason: 'not_configured' });
    }

    const { seedKeywords, pageUrl, location, languageId, maxKeywords, industry } = req.body;

    if (!seedKeywords?.length && !pageUrl) {
      return res.status(400).json({ error: 'Provide seedKeywords array or pageUrl' });
    }

    // P1-3: Validate URL before passing to Keyword Planner API
    // SSRF guard blocks the website scraper, but the same URL was leaking to GKP causing 400 errors
    let safeUrl = pageUrl || null;
    if (safeUrl) {
      const urlCheck = await validateUrl(safeUrl);
      if (!urlCheck.valid) {
        console.log('[RespondIQ] KW URL blocked (SSRF):', safeUrl, '|', urlCheck.reason);
        safeUrl = null; // Strip the URL, proceed with seeds only
      }
    }

    console.log('[RespondIQ] Keyword ideas request | seeds:', seedKeywords?.join(', ') || 'none', '| url:', safeUrl || 'none', '| location:', location || 'US');

    let ideas = await getKeywordIdeas(seedKeywords, safeUrl, location, languageId);

    // Seed expansion: if results are below minimum, retry with smarter seeds
    const MIN_KEYWORDS = 5;
    if (ideas.length < MIN_KEYWORDS && seedKeywords?.length) {
      const locationName = (location || 'United States').split(',')[0].trim();
      const expandedSeeds = [...seedKeywords];

      // P1-4: Extract product/service signals from brand name
      // "Joe's Pizza Palace" -> "pizza", "Sparkle Clean Maids" -> "clean maids"
      const brandName = (seedKeywords[0] || '').toLowerCase();
      const brandWords = brandName.replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2);
      // Common non-descriptive words to skip
      const stopWords = new Set(['the', 'and', 'for', 'our', 'your', 'inc', 'llc', 'ltd', 'corp', 'company', 'group', 'solutions', 'services', 'enterprises', 'global', 'international', 'test', 'alternative']);
      const productWords = brandWords.filter(w => !stopWords.has(w));

      // Build context-aware seeds from brand name signals
      if (productWords.length > 0) {
        const productPhrase = productWords.slice(-Math.min(productWords.length, 3)).join(' ');
        expandedSeeds.push(productPhrase + ' ' + locationName);
        expandedSeeds.push(productPhrase + ' near me');
      }

      // Also add industry-based seeds (with fixed double-space)
      if (industry) {
        const industrySeed = industry.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        if (industrySeed && !expandedSeeds.some(s => s.toLowerCase().includes(industrySeed))) {
          expandedSeeds.push(industrySeed + ' ' + locationName);
          expandedSeeds.push(industrySeed + ' near me');
        }
      }

      console.log('[RespondIQ] KW seed expansion: original returned', ideas.length, '| retrying with expanded seeds:', expandedSeeds.join(', '));
      try {
        const expandedIdeas = await getKeywordIdeas(expandedSeeds, safeUrl, location, languageId);
        const seen = new Set(ideas.map(k => k.keyword.toLowerCase()));
        for (const kw of expandedIdeas) {
          if (!seen.has(kw.keyword.toLowerCase())) { ideas.push(kw); seen.add(kw.keyword.toLowerCase()); }
        }
        console.log('[RespondIQ] KW seed expansion: total after merge:', ideas.length);
      } catch (e) {
        console.warn('[RespondIQ] KW seed expansion retry failed:', e.message);
      }
    }

    // keyword-service.js provides pre-formatted low_cpc/high_cpc strings
    // with correct micros-to-dollars conversion + live exchange rate
    const MAX_KEYWORDS = 10;
    const requestedLimit = parseInt(maxKeywords, 10) || MAX_KEYWORDS;
    const limit = Math.min(Math.max(requestedLimit, MIN_KEYWORDS), 30);
    const formatted = ideas.slice(0, limit).map(kw => ({
      keyword: kw.keyword,
      avg_monthly_searches: kw.avg_monthly_searches,
      competition: kw.competition,
      competition_index: kw.competition_index,
      low_cpc: kw.low_cpc,   // null when Google provides no bid estimate
      high_cpc: kw.high_cpc, // null when Google provides no bid estimate
    }));

    if (formatted.length < MIN_KEYWORDS) {
      console.log('[RespondIQ] Note: Only', formatted.length, 'keywords returned (below minimum of', MIN_KEYWORDS + ')');
    }
    console.log('[RespondIQ] Returning', formatted.length, 'keyword ideas');
    res.json({ keywords: formatted, fallback: false });

  } catch (err) {
    console.error('[RespondIQ] Keyword API error:', err.message);
    // Graceful fallback: never break the plan generation flow
    res.json({ keywords: [], fallback: true, reason: err.message });
  }
});





// ══════════════════════════════════════════════════════════════
// SECURE WEBHOOK PROXY: /api/trigger-webhook
// Forwards lead data to Google Sheets
// ══════════════════════════════════════════════════════════════
app.post('/api/trigger-webhook', async (req, res) => {
  const WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK;

  if (!WEBHOOK_URL) {
    console.warn('[RespondIQ] GOOGLE_SHEETS_WEBHOOK not configured');
    return res.status(200).json({ success: false, message: 'Webhook not configured' });
  }

  try {
    console.log('[RespondIQ] Forwarding lead to Google Sheets:', req.body.brandName || 'unknown');
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[RespondIQ] Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// BENCHMARK STATUS: /api/benchmarks/status
// Returns current benchmark metadata (last refresh, industries)
// ══════════════════════════════════════════════════════════════
app.get('/api/benchmarks/status', (req, res) => {
  res.json(getBenchmarkMeta());
});


// ══════════════════════════════════════════════════════════════
// LAYER 3 REFRESH: /api/refresh-benchmarks
// Scrapes WordStream/LocaliQ for latest published rates.
// Trigger manually once a quarter, or via a cron job.
// Auth: pass your GEMINI_API_KEY as a Bearer token (no new env var needed).
// ══════════════════════════════════════════════════════════════
app.post('/api/refresh-benchmarks', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || token !== process.env.GEMINI_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Pass GEMINI_API_KEY as Bearer token.' });
  }

  console.log('[RespondIQ] Benchmark refresh triggered');
  try {
    const result = await refreshBenchmarksFromWeb();
    console.log('[RespondIQ] Benchmark refresh complete:', result.updated, 'industries updated');
    res.json({
      success: true,
      updated: result.updated,
      lastRefreshed: result.lastRefreshed,
      refreshSource: result.refreshSource,
      log: result.log,
    });
  } catch (err) {
    console.error('[RespondIQ] Benchmark refresh error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Start Server ──
app.listen(PORT, () => {
  console.log(`[RespondIQ] Backend v12.6 (Gemini 3.1 Pro | MEDIUM thinking | Server-Side Prompts | SSRF Protection | Benchmark Anchors | Industry Detection) running on port ${PORT}`);
  console.log(`[RespondIQ] CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
