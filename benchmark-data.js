// ══════════════════════════════════════════════════════════════
// benchmark-data.js
// RespondIQ™ — Layer 1 Industry Benchmark Database
// Sources: WordStream / LocaliQ Annual Benchmark Reports
//          (16,000+ US campaigns across 23 industries)
// Update cycle: Quarterly via /api/refresh-benchmarks
// Last manual update: March 2026
// ══════════════════════════════════════════════════════════════

// ── In-memory state (overwritten by /api/refresh-benchmarks) ──
let lastRefreshed = 'March 2026 (baseline)';
let refreshSource = 'manual';

// ══════════════════════════════════════════════════════════════
// BENCHMARK DATABASE
// Per channel: cpc ($), cpm ($), ctr (%), cvr (%), cpa ($)
// null = channel does not use that metric (e.g. Search has no CPM)
// ══════════════════════════════════════════════════════════════
const BENCHMARKS = {

  // ── 1. E-Commerce & Retail ──
  ecommerce: {
    label: 'E-Commerce & Retail',
    channels: {
      google_search:  { cpc: 1.16, ctr: 3.17, cvr: 2.81, cpm: null,  cpa: 45.27 },
      google_display: { cpc: 0.67, ctr: 0.46, cvr: 0.84, cpm: 2.80,  cpa: 65.00 },
      meta:           { cpc: 0.70, ctr: 1.50, cvr: 1.90, cpm: 12.50, cpa: 38.00 },
      instagram:      { cpc: 0.85, ctr: 1.00, cvr: 1.40, cpm: 9.00,  cpa: 52.00 },
      tiktok:         { cpc: 1.00, ctr: 1.00, cvr: 1.10, cpm: 10.00, cpa: 55.00 },
      youtube:        { cpc: 0.49, ctr: 0.65, cvr: 0.60, cpm: 7.50,  cpa: 80.00 },
      programmatic:   { cpc: 0.80, ctr: 0.35, cvr: 0.50, cpm: 3.50,  cpa: 90.00 },
    },
    kpi_targets: { roas: 4.0, blended_cac: 45, repeat_purchase_rate: '25–35%' },
    seasonal_notes: 'Peak: Nov–Dec (Q4 holiday). Secondary: Back-to-school (Aug), Valentine\'s Day (Feb), Mother\'s Day (May).',
    confidence: 'high',
  },

  // ── 2. Legal Services ──
  legal: {
    label: 'Legal Services',
    channels: {
      google_search:  { cpc: 6.97, ctr: 4.76, cvr: 4.35, cpm: null,  cpa: 73.70  },
      google_display: { cpc: 2.00, ctr: 0.35, cvr: 1.50, cpm: 5.00,  cpa: 120.00 },
      meta:           { cpc: 1.92, ctr: 0.90, cvr: 2.50, cpm: 18.00, cpa: 85.00  },
      youtube:        { cpc: 0.70, ctr: 0.55, cvr: 0.80, cpm: 9.00,  cpa: 180.00 },
      linkedin:       { cpc: 8.00, ctr: 0.60, cvr: 1.20, cpm: 35.00, cpa: 250.00 },
      programmatic:   { cpc: 1.50, ctr: 0.30, cvr: 0.70, cpm: 5.50,  cpa: 200.00 },
    },
    kpi_targets: { lead_cost_target: 75, consultation_rate: '30–40%', close_rate: '20–30%' },
    seasonal_notes: 'Personal injury peaks post-holiday (Jan) and summer (Jul–Aug). Family law peaks Jan–Feb.',
    confidence: 'high',
  },

  // ── 3. Real Estate ──
  real_estate: {
    label: 'Real Estate',
    channels: {
      google_search:  { cpc: 2.37, ctr: 3.71, cvr: 2.47, cpm: null,  cpa: 55.91 },
      google_display: { cpc: 0.88, ctr: 0.40, cvr: 0.80, cpm: 3.50,  cpa: 90.00 },
      meta:           { cpc: 1.60, ctr: 1.10, cvr: 2.00, cpm: 14.00, cpa: 70.00 },
      instagram:      { cpc: 1.40, ctr: 0.80, cvr: 1.50, cpm: 11.00, cpa: 85.00 },
      youtube:        { cpc: 0.55, ctr: 0.50, cvr: 0.60, cpm: 8.00,  cpa: 130.00 },
      programmatic:   { cpc: 1.00, ctr: 0.30, cvr: 0.50, cpm: 4.00,  cpa: 150.00 },
    },
    kpi_targets: { cost_per_qualified_lead: 75, inquiry_to_showing_rate: '15–25%' },
    seasonal_notes: 'Spring selling season (Mar–Jun) is peak. Slower Jul–Aug and Nov–Dec.',
    confidence: 'high',
  },

  // ── 4. Healthcare & Medical ──
  healthcare: {
    label: 'Healthcare & Medical',
    channels: {
      google_search:  { cpc: 3.17, ctr: 3.27, cvr: 3.36, cpm: null,  cpa: 78.09  },
      google_display: { cpc: 1.10, ctr: 0.40, cvr: 1.10, cpm: 4.20,  cpa: 110.00 },
      meta:           { cpc: 1.40, ctr: 0.95, cvr: 2.00, cpm: 13.00, cpa: 72.00  },
      youtube:        { cpc: 0.55, ctr: 0.50, cvr: 0.70, cpm: 8.50,  cpa: 145.00 },
      programmatic:   { cpc: 1.20, ctr: 0.28, cvr: 0.60, cpm: 4.80,  cpa: 170.00 },
    },
    kpi_targets: { cost_per_appointment: 85, new_patient_acquisition_cost: 200 },
    seasonal_notes: 'Jan (new insurance year) and Oct–Nov (open enrollment). Elective peaks Jan (resolutions) and Sep.',
    confidence: 'high',
  },

  // ── 5. Financial Services & Insurance ──
  finance: {
    label: 'Financial Services & Insurance',
    channels: {
      google_search:  { cpc: 3.44, ctr: 2.65, cvr: 5.10, cpm: null,  cpa: 81.93  },
      google_display: { cpc: 1.20, ctr: 0.40, cvr: 1.60, cpm: 4.90,  cpa: 130.00 },
      meta:           { cpc: 1.80, ctr: 0.90, cvr: 2.20, cpm: 16.00, cpa: 90.00  },
      linkedin:       { cpc: 9.00, ctr: 0.55, cvr: 1.50, cpm: 40.00, cpa: 280.00 },
      youtube:        { cpc: 0.60, ctr: 0.50, cvr: 0.80, cpm: 9.00,  cpa: 190.00 },
      programmatic:   { cpc: 1.30, ctr: 0.30, cvr: 0.70, cpm: 5.20,  cpa: 210.00 },
    },
    kpi_targets: { cost_per_application: 90, lead_to_customer_rate: '8–15%' },
    seasonal_notes: 'Tax season (Jan–Apr). Insurance open enrollment (Oct–Dec). Lending peaks in spring home-buying season.',
    confidence: 'high',
  },

  // ── 6. B2B / SaaS / Technology ──
  b2b_saas: {
    label: 'B2B / SaaS / Technology',
    channels: {
      google_search:  { cpc: 3.80, ctr: 2.55, cvr: 2.23, cpm: null,  cpa: 103.00 },
      google_display: { cpc: 1.50, ctr: 0.35, cvr: 0.60, cpm: 6.00,  cpa: 175.00 },
      linkedin:       { cpc: 8.50, ctr: 0.65, cvr: 1.80, cpm: 38.00, cpa: 210.00 },
      meta:           { cpc: 1.90, ctr: 0.80, cvr: 1.20, cpm: 17.00, cpa: 130.00 },
      youtube:        { cpc: 0.65, ctr: 0.45, cvr: 0.50, cpm: 9.50,  cpa: 220.00 },
      programmatic:   { cpc: 1.60, ctr: 0.28, cvr: 0.45, cpm: 6.50,  cpa: 280.00 },
    },
    kpi_targets: { cac: 150, mrr_payback_months: 12, free_trial_conversion: '15–25%' },
    seasonal_notes: 'Q1 budget flush (Jan–Mar) and Q4 year-end spend are peaks. Summer (Jul–Aug) typically slower.',
    confidence: 'high',
  },

  // ── 7. Education & e-Learning ──
  education: {
    label: 'Education & e-Learning',
    channels: {
      google_search:  { cpc: 2.40, ctr: 3.78, cvr: 3.39, cpm: null,  cpa: 72.70  },
      google_display: { cpc: 0.90, ctr: 0.40, cvr: 1.00, cpm: 3.80,  cpa: 100.00 },
      meta:           { cpc: 1.20, ctr: 1.00, cvr: 1.80, cpm: 10.00, cpa: 60.00  },
      youtube:        { cpc: 0.50, ctr: 0.55, cvr: 0.70, cpm: 7.50,  cpa: 120.00 },
      tiktok:         { cpc: 0.90, ctr: 1.10, cvr: 0.90, cpm: 9.00,  cpa: 90.00  },
      programmatic:   { cpc: 0.90, ctr: 0.30, cvr: 0.55, cpm: 4.00,  cpa: 140.00 },
    },
    kpi_targets: { cost_per_enrollment: 75, completion_rate_target: '60–70%' },
    seasonal_notes: 'Back-to-school (Aug–Sep), New Year resolutions (Jan), Spring enrollment (Mar–Apr).',
    confidence: 'high',
  },

  // ── 8. Home Services & Trades ──
  home_services: {
    label: 'Home Services & Trades',
    channels: {
      google_search:  { cpc: 6.55, ctr: 4.80, cvr: 7.05, cpm: null,  cpa: 66.02 },
      google_display: { cpc: 1.80, ctr: 0.45, cvr: 2.00, cpm: 5.50,  cpa: 95.00 },
      meta:           { cpc: 1.50, ctr: 1.00, cvr: 2.50, cpm: 12.00, cpa: 55.00 },
      nextdoor:       { cpc: 1.20, ctr: 0.80, cvr: 2.00, cpm: 8.00,  cpa: 60.00 },
      programmatic:   { cpc: 1.40, ctr: 0.32, cvr: 0.80, cpm: 4.50,  cpa: 130.00 },
    },
    kpi_targets: { cost_per_booked_job: 70, average_job_value: 350 },
    seasonal_notes: 'Spring (Mar–May) peaks for landscaping, roofing, HVAC. Emergency services (plumbing, HVAC repair) year-round.',
    confidence: 'high',
  },

  // ── 9. Automotive ──
  automotive: {
    label: 'Automotive',
    channels: {
      google_search:  { cpc: 2.46, ctr: 4.00, cvr: 2.27, cpm: null,  cpa: 33.52  },
      google_display: { cpc: 0.90, ctr: 0.45, cvr: 0.80, cpm: 3.60,  cpa: 80.00  },
      meta:           { cpc: 1.30, ctr: 1.00, cvr: 1.60, cpm: 11.00, cpa: 62.00  },
      youtube:        { cpc: 0.55, ctr: 0.55, cvr: 0.60, cpm: 8.50,  cpa: 100.00 },
      programmatic:   { cpc: 1.10, ctr: 0.32, cvr: 0.55, cpm: 4.20,  cpa: 130.00 },
    },
    kpi_targets: { cost_per_test_drive_request: 40, showroom_visit_rate: '10–15%' },
    seasonal_notes: 'Year-end clearance (Nov–Dec). Spring selling (Mar–Apr). Tax refund period (Feb–Apr) for used vehicles.',
    confidence: 'high',
  },

  // ── 10. Travel & Hospitality ──
  travel: {
    label: 'Travel & Hospitality',
    channels: {
      google_search:  { cpc: 1.63, ctr: 4.68, cvr: 3.60, cpm: null,  cpa: 44.73  },
      google_display: { cpc: 0.70, ctr: 0.45, cvr: 1.00, cpm: 3.00,  cpa: 75.00  },
      meta:           { cpc: 0.90, ctr: 1.20, cvr: 1.80, cpm: 9.50,  cpa: 48.00  },
      instagram:      { cpc: 0.85, ctr: 0.90, cvr: 1.30, cpm: 7.50,  cpa: 60.00  },
      youtube:        { cpc: 0.50, ctr: 0.55, cvr: 0.60, cpm: 7.00,  cpa: 100.00 },
      programmatic:   { cpc: 0.85, ctr: 0.33, cvr: 0.55, cpm: 3.80,  cpa: 120.00 },
    },
    kpi_targets: { cost_per_booking: 50, abandonment_recovery_rate: '15–20%' },
    seasonal_notes: 'Summer (Jun–Aug) and holiday travel (Nov–Dec). Booking lead time typically 6–8 weeks ahead.',
    confidence: 'high',
  },

  // ── 11. Restaurants & Food & Beverage ──
  restaurant: {
    label: 'Restaurants & Food & Beverage',
    channels: {
      google_search:  { cpc: 1.95, ctr: 4.10, cvr: 5.00, cpm: null, cpa: 12.00 },
      google_display: { cpc: 0.60, ctr: 0.40, cvr: 1.50, cpm: 2.80, cpa: 28.00 },
      meta:           { cpc: 0.75, ctr: 1.30, cvr: 2.20, cpm: 9.00, cpa: 18.00 },
      instagram:      { cpc: 0.70, ctr: 1.00, cvr: 1.80, cpm: 7.00, cpa: 22.00 },
      tiktok:         { cpc: 0.80, ctr: 1.20, cvr: 1.20, cpm: 8.50, cpa: 25.00 },
      programmatic:   { cpc: 0.70, ctr: 0.35, cvr: 0.70, cpm: 3.20, cpa: 40.00 },
    },
    kpi_targets: { cost_per_order: 14, repeat_order_rate: '30–40%' },
    seasonal_notes: 'Valentine\'s Day (Feb), Mother\'s Day (May), Thanksgiving/Christmas (Nov–Dec) are high-value reservation periods.',
    confidence: 'medium',
  },

  // ── 12. Non-Profit & Fundraising ──
  nonprofit: {
    label: 'Non-Profit & Fundraising',
    channels: {
      google_search:  { cpc: 1.43, ctr: 4.83, cvr: 4.29, cpm: null, cpa: 81.40  },
      google_display: { cpc: 0.55, ctr: 0.40, cvr: 1.00, cpm: 2.50, cpa: 95.00  },
      meta:           { cpc: 0.80, ctr: 1.10, cvr: 2.00, cpm: 9.00, cpa: 45.00  },
      youtube:        { cpc: 0.45, ctr: 0.50, cvr: 0.70, cpm: 6.50, cpa: 110.00 },
    },
    kpi_targets: { cost_per_donation: 50, average_donation_size: 75 },
    seasonal_notes: 'Year-end giving (Nov–Dec) is critical — typically 30% of annual donations. GivingTuesday is a key moment.',
    confidence: 'medium',
  },

  // ── 13. Beauty, Fashion & Personal Care ──
  beauty_fashion: {
    label: 'Beauty, Fashion & Personal Care',
    channels: {
      google_search:  { cpc: 1.20, ctr: 3.30, cvr: 2.50, cpm: null, cpa: 35.00 },
      google_display: { cpc: 0.65, ctr: 0.45, cvr: 0.90, cpm: 3.00, cpa: 58.00 },
      meta:           { cpc: 0.70, ctr: 1.40, cvr: 1.80, cpm: 10.50, cpa: 32.00 },
      instagram:      { cpc: 0.75, ctr: 1.20, cvr: 1.60, cpm: 8.50, cpa: 38.00 },
      tiktok:         { cpc: 0.90, ctr: 1.30, cvr: 1.20, cpm: 9.50, cpa: 42.00 },
      pinterest:      { cpc: 0.55, ctr: 0.50, cvr: 0.80, cpm: 5.00, cpa: 55.00 },
      youtube:        { cpc: 0.50, ctr: 0.55, cvr: 0.70, cpm: 7.00, cpa: 80.00 },
    },
    kpi_targets: { roas: 3.5, repeat_purchase_rate: '30–40%' },
    seasonal_notes: 'Holiday (Nov–Dec), Valentine\'s (Feb), Mother\'s Day (May). Launch spikes are campaign-specific.',
    confidence: 'medium',
  },

  // ── DEFAULT FALLBACK ──
  default: {
    label: 'General / Cross-Industry',
    channels: {
      google_search:  { cpc: 2.69, ctr: 3.17, cvr: 3.75, cpm: null,  cpa: 48.96  },
      google_display: { cpc: 0.80, ctr: 0.40, cvr: 0.90, cpm: 3.50,  cpa: 90.00  },
      meta:           { cpc: 1.20, ctr: 1.00, cvr: 1.80, cpm: 12.00, cpa: 65.00  },
      instagram:      { cpc: 1.00, ctr: 0.80, cvr: 1.30, cpm: 9.00,  cpa: 80.00  },
      linkedin:       { cpc: 7.50, ctr: 0.55, cvr: 1.20, cpm: 35.00, cpa: 200.00 },
      youtube:        { cpc: 0.55, ctr: 0.50, cvr: 0.60, cpm: 8.00,  cpa: 130.00 },
      tiktok:         { cpc: 0.95, ctr: 1.05, cvr: 1.00, cpm: 9.50,  cpa: 70.00  },
      programmatic:   { cpc: 1.00, ctr: 0.30, cvr: 0.60, cpm: 4.00,  cpa: 140.00 },
    },
    kpi_targets: {},
    seasonal_notes: 'No industry-specific seasonality. Review with client.',
    confidence: 'medium',
  },
};


// ══════════════════════════════════════════════════════════════
// INDUSTRY KEY RESOLVER
// Maps free-text industry input to a BENCHMARKS key
// ══════════════════════════════════════════════════════════════
const INDUSTRY_KEYWORDS = {
  ecommerce:      ['ecommerce', 'e-commerce', 'retail', 'shopping', 'online store', 'dtc', 'direct to consumer', 'shopify'],
  legal:          ['legal', 'law', 'attorney', 'lawyer', 'law firm', 'litigation', 'personal injury', 'family law'],
  real_estate:    ['real estate', 'property', 'realtor', 'realty', 'housing', 'mortgage', 'home buying', 'home selling'],
  healthcare:     ['healthcare', 'health', 'medical', 'clinic', 'hospital', 'dental', 'pharmacy', 'wellness', 'telehealth', 'medspa'],
  finance:        ['finance', 'financial', 'insurance', 'banking', 'investment', 'fintech', 'accounting', 'tax', 'credit', 'lending'],
  b2b_saas:       ['saas', 'software', 'b2b', 'technology', 'tech', 'platform', 'enterprise', 'crm', 'erp', 'cloud'],
  education:      ['education', 'e-learning', 'elearning', 'online course', 'university', 'tutoring', 'training', 'edtech', 'school'],
  home_services:  ['home services', 'home improvement', 'plumbing', 'hvac', 'roofing', 'landscaping', 'cleaning', 'pest control', 'electrician', 'contractor'],
  automotive:     ['automotive', 'auto', 'car', 'vehicle', 'dealership', 'car wash', 'auto repair'],
  travel:         ['travel', 'hospitality', 'hotel', 'tourism', 'airline', 'vacation', 'tour', 'booking', 'resort'],
  restaurant:     ['restaurant', 'food', 'beverage', 'cafe', 'coffee', 'dining', 'delivery', 'catering', 'bakery', 'bar'],
  nonprofit:      ['nonprofit', 'non-profit', 'ngo', 'charity', 'foundation', 'fundraising', 'cause', 'advocacy'],
  beauty_fashion: ['beauty', 'fashion', 'cosmetics', 'skincare', 'haircare', 'apparel', 'clothing', 'makeup', 'personal care', 'salon', 'spa'],
};

function resolveIndustryKey(industryString) {
  if (!industryString) return 'default';
  const lower = industryString.toLowerCase();
  for (const [key, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return key;
  }
  return 'default';
}


// ══════════════════════════════════════════════════════════════
// BUILD PROMPT BLOCK — RULE 17
//
// Design intent:
//   These benchmarks are the STARTING ANCHOR, not a ceiling.
//   Gemini is explicitly expected to adjust rates up or down
//   based on contextual signals the user provides — geography,
//   audience specificity, campaign type, competition level, etc.
//   What the benchmarks prevent is wild cross-plan inconsistency
//   (e.g. the same industry getting $0.50 CPC one run and $8.00
//   the next with no change in user inputs).
// ══════════════════════════════════════════════════════════════
function buildBenchmarkPromptBlock(industryString) {
  const key = resolveIndustryKey(industryString);
  const data = BENCHMARKS[key];

  let block = `\nRULE 17 — INDUSTRY BENCHMARK ANCHORS (${data.label}):\n`;
  block += `Source: WordStream / LocaliQ Annual Benchmark Report | ${lastRefreshed} | Confidence: ${data.confidence.toUpperCase()}\n\n`;

  block += `HOW TO USE THESE BENCHMARKS:\n`;
  block += `These rates are the verified industry baseline for a typical US campaign in this vertical. `;
  block += `They are your STARTING ANCHOR — not a ceiling. You are expected to adjust them based on `;
  block += `the specific context this user has provided. Apply the following adjustment logic:\n\n`;

  block += `  ADJUST UPWARD (higher CPC / lower CVR) when:\n`;
  block += `    - Targeting highly competitive sub-niches or premium keywords\n`;
  block += `    - Campaign geography is an expensive DMA (NYC, SF, LA, Chicago)\n`;
  block += `    - Audience is a narrow B2B decision-maker segment\n`;
  block += `    - Campaign objective is non-branded demand generation\n`;
  block += `    - Company size is small with no brand recognition\n\n`;

  block += `  ADJUST DOWNWARD (lower CPC / higher CVR) when:\n`;
  block += `    - Targeting lower-competition long-tail or local keywords\n`;
  block += `    - Geography is a mid-tier or rural US market, or a non-US market\n`;
  block += `    - Campaign is retargeting or branded search (strong purchase intent)\n`;
  block += `    - Brand has strong existing awareness or organic presence\n\n`;

  block += `  MARKET ADJUSTMENTS (from US baseline):\n`;
  block += `    UK: CPC approx −10%, CPM approx −15% | AUS: CPC approx −10% | CA: similar to US\n`;
  block += `    IN: CPC approx −70%, CPM approx −80% | UAE/SG: CPC approx +10–20%\n\n`;

  block += `  WHEN IN DOUBT: Use the baseline rates below, clearly label them as "industry average",\n`;
  block += `  and note what contextual factors would push them higher or lower for this brand.\n\n`;

  block += `BASELINE RATES — ${data.label}:\n`;
  for (const [channel, rates] of Object.entries(data.channels)) {
    const label = channel.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const parts = [];
    if (rates.cpc  !== null) parts.push(`CPC: $${rates.cpc}`);
    if (rates.cpm  !== null) parts.push(`CPM: $${rates.cpm}`);
    if (rates.ctr  !== null) parts.push(`CTR: ${rates.ctr}%`);
    if (rates.cvr  !== null) parts.push(`CVR: ${rates.cvr}%`);
    if (rates.cpa  !== null) parts.push(`CPA: $${rates.cpa}`);
    block += `  ${label}: ${parts.join(' | ')}\n`;
  }

  if (Object.keys(data.kpi_targets).length > 0) {
    block += `\nKPI TARGETS FOR THIS VERTICAL:\n`;
    for (const [kpi, val] of Object.entries(data.kpi_targets)) {
      block += `  ${kpi.replace(/_/g, ' ')}: ${val}\n`;
    }
  }

  if (data.seasonal_notes) {
    block += `\nSEASONALITY: ${data.seasonal_notes}\n`;
  }

  block += `\nFOR CHANNELS NOT IN THE BASELINE ABOVE (DSPs, CTV/OTT, Programmatic Display/Video/Native/Audio/DOOH, `;
  block += `TikTok, Reddit, Amazon Ads, Snapchat, Pinterest, X/Twitter, Spotify, and any other platform `;
  block += `not listed in the baseline rates table):\n`;
  block += `  - Use your Search grounding capability to look up current benchmark rates BEFORE assigning `;
  block += `any CPM, CPC, or CTR figure for these channels.\n`;
  block += `  - Search specifically for: "[platform] average CPM 2025 2026", "[platform] advertising `;
  block += `benchmark [industry]", "IAB programmatic CPM benchmark 2025", "eMarketer CTV CPM 2025", `;
  block += `"Basis Technologies programmatic benchmark report", "[DSP name] media kit rates".\n`;
  block += `  - Label all rates sourced this way as "search-verified estimate" in the plan output — `;
  block += `never present them with the same confidence as the verified baseline rates above.\n`;
  block += `  - If Search returns a range, use the midpoint and note the range in parentheses.\n`;
  block += `  - If Search returns no usable result, state the rate as "market rate — verify with platform" `;
  block += `rather than inventing a number from training memory.\n`;
  block += `  - This applies especially to programmatic channels where rates vary significantly by `;
  block += `deal type: open auction CPMs differ from PMP and programmatic direct — specify which.\n\n`;

  block += `\nCONSISTENCY REQUIREMENT: Whatever rates you choose for a channel, use the SAME rates `;
  block += `consistently across ALL sections of this plan (Section 05 budget, Section 09 channel detail, `;
  block += `Section 16 benchmarks). Do not use $${BENCHMARKS[key].channels.google_search?.cpc} CPC in `;
  block += `one section and a different CPC for the same channel in another section.\n\n`;

  block += `SECTION 16 RULE: In Section 16 (Industry Benchmark Comparison), the "Industry Average" column `;
  block += `MUST display the BASELINE RATES listed above, NOT the plan's own targets. The "Plan Target" `;
  block += `column shows the rates you chose for THIS campaign (which may be adjusted up or down from the `;
  block += `baseline). The "vs. Benchmark" column then compares them. If you adjusted a rate upward, mark `;
  block += `it "Above avg" with a warning. If you adjusted downward, mark it "Below avg" with a checkmark. `;
  block += `If you used the baseline rate exactly, mark it "At benchmark". The two columns MUST show `;
  block += `DIFFERENT values when you have adjusted rates for the campaign context. Identical values in `;
  block += `both columns defeat the purpose of the benchmark comparison.\n`;

  return block;
}


// ══════════════════════════════════════════════════════════════
// LAYER 3: Live refresh from WordStream / LocaliQ
// Called by POST /api/refresh-benchmarks
// Attempts to scrape latest published benchmark tables
// Falls back gracefully if page structure has changed
// ══════════════════════════════════════════════════════════════
async function refreshBenchmarksFromWeb() {
  const log = [];
  let updated = 0;

  const sources = [
    {
      url: 'https://www.wordstream.com/blog/ws/2016/02/29/google-adwords-industry-benchmarks',
      label: 'WordStream Google Ads Benchmarks',
      parser: parseWordStreamRates,
    },
    {
      url: 'https://localiq.com/blog/google-ads-benchmarks/',
      label: 'LocaliQ Google Ads Benchmarks',
      parser: parseWordStreamRates, // same parent company, same table structure
    },
  ];

  for (const source of sources) {
    try {
      log.push(`Fetching: ${source.label}`);
      const response = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RespondIQ/2.0 Benchmark-Refresher)' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        log.push(`  ✗ HTTP ${response.status} — skipping`);
        continue;
      }

      const html = await response.text();
      const parsed = parseWordStreamRates(html);

      if (parsed && Object.keys(parsed).length > 0) {
        for (const [industryKey, rates] of Object.entries(parsed)) {
          if (BENCHMARKS[industryKey]) {
            Object.assign(BENCHMARKS[industryKey].channels.google_search, rates);
            updated++;
            log.push(`  ✓ Updated ${industryKey}: CPC $${rates.cpc || '?'} | CTR ${rates.ctr || '?'}% | CVR ${rates.cvr || '?'}%`);
          }
        }
      } else {
        log.push(`  ⚠ No parseable rates found (page structure may have changed — manual update needed)`);
      }
    } catch (err) {
      log.push(`  ✗ Error fetching ${source.label}: ${err.message}`);
    }
  }

  if (updated > 0) {
    lastRefreshed = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    refreshSource = 'auto-scrape';
  }

  return { updated, log, lastRefreshed, refreshSource };
}

// ── HTML table parser: looks for industry + rate rows ──
// WordStream and LocaliQ both use <table> with industry names + % / $ values
function parseWordStreamRates(html) {
  const results = {};
  const tableRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of tableRows) {
    const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
      .map(cell => cell.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());

    if (cells.length < 3) continue;

    const industryKey = resolveIndustryKey(cells[0]);
    if (industryKey === 'default') continue;

    const nums = cells.slice(1)
      .map(c => { const m = c.match(/[\d.]+/); return m ? parseFloat(m[0]) : null; })
      .filter(n => n !== null && n > 0);

    if (nums.length >= 3) {
      const [ctr, cpc, cvr] = nums;
      // Sanity check: reject implausible values
      if (cpc > 0.10 && cpc < 50 && ctr > 0 && ctr < 30 && cvr > 0 && cvr < 30) {
        results[industryKey] = { ctr, cpc, cvr };
      }
    }
  }

  return results;
}

// ── Metadata for /api/debug and /api/benchmarks/status ──
function getBenchmarkMeta() {
  return {
    lastRefreshed,
    refreshSource,
    industries: Object.keys(BENCHMARKS).filter(k => k !== 'default'),
    industryCount: Object.keys(BENCHMARKS).length - 1,
  };
}

module.exports = {
  BENCHMARKS,
  resolveIndustryKey,
  buildBenchmarkPromptBlock,
  refreshBenchmarksFromWeb,
  getBenchmarkMeta,
};
