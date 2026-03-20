// ═══════════════════════════════════════════════════════════════
// RespondIQ™ v12 — Gemini 3.1 Pro + Medium Thinking + Search Grounding
// AI Model: gemini-3.1-pro-preview (thinking_level: MEDIUM)
// Hosted on: Render.com (Web Service)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const { getKeywordIdeas, isKeywordServiceConfigured } = require('./keyword-service');
const { getCompetitiveIntelligence, buildCompetitorPromptBlock } = require('./competitive-intel-service');
const { BENCHMARKS, buildBenchmarkPromptBlock, refreshBenchmarksFromWeb, getBenchmarkMeta } = require('./benchmark-data');

const app = express();
const PORT = process.env.PORT || 10000;

// ── Strict CORS: Only allow requests from your frontend ──
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://respondiq-jidy.onrender.com',
  'http://localhost:3000'
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
// PRIORITY 1: SSRF VALIDATION
// Rejects private IPs, metadata endpoints, non-standard ports
// ══════════════════════════════════════════════════════════════
const { URL } = require('url');
const dns = require('dns');
const { promisify } = require('util');
const dnsLookup = promisify(dns.lookup);

function isPrivateIP(ip) {
  // IPv4 private/reserved ranges
  if (/^127\./.test(ip)) return true;                      // loopback
  if (/^10\./.test(ip)) return true;                       // Class A private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;  // Class B private
  if (/^192\.168\./.test(ip)) return true;                  // Class C private
  if (/^169\.254\./.test(ip)) return true;                  // link-local / AWS metadata
  if (/^100\.100\.100\.200/.test(ip)) return true;          // Alibaba/cloud metadata
  if (ip === '0.0.0.0') return true;
  if (ip === '::1' || ip === '::') return true;             // IPv6 loopback
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

  // DNS resolution check: reject if it resolves to a private IP
  try {
    const { address } = await dnsLookup(parsed.hostname);
    if (isPrivateIP(address)) {
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
10. For every CPM, CPC, CTR, and industry benchmark figure, you MUST use your search capability to look up current rates before writing any number. Search for "[industry] average CPM 2025", "[channel] advertising benchmark [industry] 2025", "average CPC [channel] [industry]", and equivalent queries. Use ONLY search-verified rates, never use memorised training data for cost figures. If search returns a range, use the midpoint. Every benchmark in the benchmarks array must reference a figure you verified via search, not estimated from memory.`;
}

function buildUserPrompt(data, bInfo, months, totalBudgetLow, totalBudgetHigh, totalBudgetMid, keywordData, competitorIntelBlock) {
  const funnelAdvice = FUNNEL_GUIDE[data.goal] || FUNNEL_GUIDE['Sales & Conversions'];

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
Selected Channels: ${data.platform}
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
Provide a benchmarks array comparing the plan's projected metrics against industry averages for ${data.industry}. Include 4-6 key metrics (CPC, CPM, CTR, CPA, conversion rate, ROAS as relevant). For each, show: the plan's target, the industry average, and whether the plan is above/below/at benchmark. ${data.pastPerformance ? 'The client reports past performance of: ' + data.pastPerformance + '. Use this to calibrate targets, if their historical CPA is higher than industry average, set realistic goals that improve on their past but do not assume best-in-class performance overnight.' : 'No past performance data provided, use industry midpoints as targets.'}

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
    service: 'RespondIQ™ Backend v12.6 (Gemini 3.1 Pro + Server-Side Prompts + SSRF Protection + Keyword Planner + Competitive Intel + Benchmark Anchors)',
    model: 'gemini-3.1-pro-preview',
    thinking: 'MEDIUM',
    hosting: 'Render.com'
  });
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

    const prompt = `You are an industry classification expert. Determine the ACTUAL industry for the brand "${brandName}".

The user selected: "${formIndustry}"

${websiteText ? `Website content:\n${websiteText.substring(0, 2000)}` : 'No website content available. Use the brand name and your knowledge to classify.'}

VALID INDUSTRY KEYS (pick exactly one):
${validIndustries}
  "default" = General / Cross-Industry (use ONLY if no other key fits)

RULES:
- Base your decision on what the brand ACTUALLY does, not what the user selected.
- If the brand is a car wash, auto repair shop, dealership, or similar, use "automotive".
- If the brand is a local service provider (plumber, HVAC, etc.), use "home_services".
- If the user's selection is correct, return that same key.
- Return ONLY a JSON object, nothing else.

Return: {"industry_key": "the_key", "industry_label": "Human Readable Label", "corrected": true/false, "reason": "one sentence explanation"}`;

    console.log('[RespondIQ] Detecting actual industry for:', brandName, '| form said:', formIndustry);

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 512,
        tools: [{ googleSearch: {} }],
      }
    });

    const text = response.text || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      // Validate the returned key exists in our benchmark database
      if (result.industry_key && BENCHMARKS[result.industry_key]) {
        console.log('[RespondIQ] Industry detection result:',
          result.corrected ? `CORRECTED "${formIndustry}" → "${result.industry_label}"` : `CONFIRMED "${formIndustry}"`,
          '| reason:', result.reason || 'n/a');
        return {
          key: result.industry_key,
          label: result.industry_label || BENCHMARKS[result.industry_key].label,
          corrected: !!result.corrected,
          reason: result.reason || '',
          formIndustry: formIndustry,
        };
      }
    }

    console.warn('[RespondIQ] Industry detection: could not parse response, using form value');
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
    const prompt = `You are a competitive analyst. Identify 3-5 REAL companies that are direct competitors to "${brandName}" in the ${industry} industry.

IMPORTANT RULES:
- ${brandName} is a ${companySize} company. Match competitors by SIMILAR size.
- Do NOT pick Fortune 500 giants unless ${brandName} is also a large enterprise.
- Every name must be a real, existing company (not fictional).
- Pick companies that ${brandName} would actually compete against for the same customers.
${websiteText ? `\nContext from their website:\n${websiteText.substring(0, 1500)}` : ''}

Return ONLY a JSON array of company names, nothing else. Example: ["Company A","Company B","Company C"]`;

    console.log('[RespondIQ] Auto-identifying competitors for:', brandName);

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 1024
      }
    });

    const text = response.text || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const names = JSON.parse(match[0]);
      if (Array.isArray(names) && names.length > 0) {
        console.log('[RespondIQ] Auto-identified competitors:', names.join(', '));
        return names.slice(0, 5);
      }
    }
    console.warn('[RespondIQ] Could not parse competitor names from:', text.substring(0, 200));
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
      console.log('[RespondIQ] Refine request:', requestBody.refine_instruction.substring(0, 80));

      const refineSystem = `You are a senior media strategist. The user has an existing media plan (JSON) and wants changes.
Return the FULL updated JSON plan (not a partial diff).
Maintain valid math: all budget_pct must sum to 100%, impressions must recalculate from budget changes, and all fields must remain populated.
Return ONLY valid JSON, no markdown, no code fences, no explanation text.`;

      const refineUser = `Here is the current media plan JSON:\n\n${JSON.stringify(requestBody.current_plan)}\n\nThe user wants the following change:\n"${requestBody.refine_instruction}"\n\nReturn the FULL updated JSON plan with this change applied. Recalculate all affected numbers (budget splits, impressions, KPIs) to maintain mathematical consistency. Return ONLY the JSON object.`;

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
    const data = requestBody.form_data;
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

    if (data.brandName && formIndustry) {
      industryOverride = await detectActualIndustry(data.brandName, formIndustry, websiteIntel.text);
    }

    const effectiveIndustry = (industryOverride && industryOverride.corrected)
      ? industryOverride.label
      : formIndustry;
    const effectiveIndustryKey = (industryOverride && industryOverride.corrected)
      ? industryOverride.key
      : null;

    if (industryOverride && industryOverride.corrected) {
      console.log('[RespondIQ] Industry CORRECTED:', formIndustry, '->', effectiveIndustry, '(key:', industryOverride.key + ')');
    }

    // ── AUTO-TRIGGER: Competitive Intelligence via Google Ads Transparency ──
    let competitiveIntelResults = [];
    let competitiveIntelBlock = frontendCompetitorIntelBlock;

    if (!data.competitors) {
      try {
        const industry = effectiveIndustry;
        const companySize = data.companySize || '';

        console.log('[RespondIQ] Auto-trigger competitive intel for:', data.brandName, '|', industry, '|', companySize);

        const identifiedNames = await identifyCompetitors(data.brandName, industry, companySize, websiteIntel.text);

        if (identifiedNames.length > 0) {
          competitiveIntelResults = await getCompetitiveIntelligence(identifiedNames);
          competitiveIntelBlock = buildCompetitorPromptBlock(competitiveIntelResults);

          const foundCount = competitiveIntelResults.filter(r => r.found).length;
          console.log('[RespondIQ] Auto-trigger result:', foundCount, 'of', identifiedNames.length, 'found in Transparency Center');
        } else {
          console.log('[RespondIQ] Auto-trigger: no competitors identified, skipping Transparency lookup');
        }
      } catch (err) {
        console.warn('[RespondIQ] Auto-trigger competitive intel failed (graceful):', err.message);
      }
    }

    // ── BUILD PROMPTS SERVER-SIDE (Priority 2) ──
    const systemInstruction = buildSystemPrompt(data);
    let userPrompt = buildUserPrompt(data, bInfo, months, totalBudgetLow, totalBudgetHigh, totalBudgetMid, keywordData, competitiveIntelBlock);

    // ── Inject Website Intelligence into user prompt ──
    if (websiteIntel.text || websiteIntel.techStack.length || websiteIntel.socialLinks.length) {
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

    // ── Inject industry correction notice into prompt (if corrected) ──
    if (industryOverride && industryOverride.corrected) {
      userPrompt += '\n\nINDUSTRY CORRECTION APPLIED: The user selected "' + formIndustry +
        '" but pre-analysis detected this brand operates in "' + effectiveIndustry + '". ' +
        'The benchmark anchors and competitor identification in this prompt ALREADY use ' + effectiveIndustry + ' data. ' +
        'Set industry_mismatch to true and detected_industry to "' + effectiveIndustry + '" in your JSON output.';
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

    if (industryOverride && industryOverride.corrected) {
      result._industry_override = {
        form_industry: industryOverride.formIndustry,
        detected_industry: industryOverride.label,
        detected_key: industryOverride.key,
        reason: industryOverride.reason,
      };
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
    socialLinks: allSocial
  };
}

async function fetchPage(url) {
  // SSRF validation: reject private IPs, metadata endpoints, non-standard ports
  const validation = await validateUrl(url);
  if (!validation.valid) {
    console.warn('[RespondIQ] fetchPage blocked (SSRF):', url, '|', validation.reason);
    return { text: '', techStack: [], socialLinks: [] };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(validation.url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RespondIQ/2.0)', 'Accept': 'text/html' }
    });
    clearTimeout(timer);
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
// GOOGLE ADS TRANSPARENCY: /api/competitive-intel
// Returns real competitor ad data (FREE, no API keys needed)
// ══════════════════════════════════════════════════════════════
app.post('/api/competitive-intel', async (req, res) => {
  try {
    const { competitors } = req.body;

    if (!competitors || !Array.isArray(competitors) || competitors.length === 0) {
      return res.json({ results: [], fallback: true, reason: 'no_competitors' });
    }

    // Cap at 8 competitors to keep response time reasonable
    const capped = competitors.slice(0, 8);
    console.log('[RespondIQ] Competitive intel request for:', capped.join(', '));

    const results = await getCompetitiveIntelligence(capped);
    const promptBlock = buildCompetitorPromptBlock(results);

    const found = results ? results.filter(r => r.found) : [];
    console.log('[RespondIQ] Competitive intel:', found.length, 'of', capped.length, 'found');

    res.json({
      results: results || [],
      prompt_block: promptBlock,
      fallback: found.length === 0,
      reason: found.length === 0 ? 'no_matches_found' : null,
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

    const { seedKeywords, pageUrl, location, languageId, maxKeywords } = req.body;

    if (!seedKeywords?.length && !pageUrl) {
      return res.status(400).json({ error: 'Provide seedKeywords array or pageUrl' });
    }

    console.log('[RespondIQ] Keyword ideas request | seeds:', seedKeywords?.join(', ') || 'none', '| url:', pageUrl || 'none', '| location:', location || 'US');

    const ideas = await getKeywordIdeas(seedKeywords, pageUrl, location, languageId);

    // keyword-service.js provides pre-formatted low_cpc/high_cpc strings
    // with correct micros-to-dollars conversion + live exchange rate
    const MIN_KEYWORDS = 5;
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
