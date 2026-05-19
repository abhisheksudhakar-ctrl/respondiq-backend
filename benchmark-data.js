// =============================================================
// benchmark-data.js
// RespondIQ - Layer 1 Industry Benchmark Database
// Sources: verified 2025 publisher data, keyed by BENCHMARK_SOURCES.
// Update cycle: Quarterly via /api/refresh-benchmarks
// Last manual update: May 2026
// =============================================================

// =============================================================
// BENCHMARK_SOURCES: master registry of all data publishers
// Used by buildBenchmarkPromptBlock (this file), the API response
// in server.js (/generate-plan), and the frontend Data Sources bar.
// `tier: premium` = surfaced as logo/chip in Data Sources bar.
// `tier: standard` = visible in the API response and Section 16
//                    "via" footnote, but not promoted in the chip.
// =============================================================
const BENCHMARK_SOURCES = {
  localiq_search_2025: {
    label: 'LocaliQ / WordStream Search Advertising Benchmarks 2025',
    publisher: 'LocaliQ / WordStream',
    short_name: 'LocaliQ Search',
    url: 'https://localiq.com/blog/search-advertising-benchmarks/',
    period: '2025 (campaigns Apr 2024 - Mar 2025)',
    methodology: '16,000+ US campaigns; cross-industry search benchmark dataset',
    tier: 'premium',
    confidence: 'verified'
  },
  localiq_facebook_2025: {
    label: 'LocaliQ Facebook Advertising Benchmarks 2025',
    publisher: 'LocaliQ',
    short_name: 'LocaliQ Facebook',
    url: 'https://localiq.com/blog/facebook-advertising-benchmarks/',
    period: '2025',
    methodology: 'Industry benchmarks split by traffic and lead campaign objectives',
    tier: 'premium',
    confidence: 'verified'
  },
  closely_linkedin_2025: {
    label: 'Closely LinkedIn Ad Benchmarks 2025',
    publisher: 'Closely',
    short_name: 'Closely LinkedIn',
    url: 'https://blog.closelyhq.com/linkedin-ad-benchmarks-cpc-cpm-and-ctr-by-industry/',
    period: '2025',
    methodology: 'LinkedIn performance benchmarks by campaign, region, industry, format',
    tier: 'premium',
    confidence: 'derived'
  },
  hockeystack_linkedin_b2b_2025: {
    label: 'HockeyStack 2025 LinkedIn Ads Benchmark Report for B2B Marketers',
    publisher: 'HockeyStack',
    short_name: 'HockeyStack LinkedIn',
    url: 'https://www.hockeystack.com/lab-blog-posts/linkedin-ads-benchmarks',
    period: '2025 (3-year dataset)',
    methodology: '70+ B2B SaaS companies, $28M ad spend, $5M-$1B ARR',
    tier: 'premium',
    confidence: 'verified'
  },
  gupta_social_cpm_2025: {
    label: 'Gupta Media Social Media CPM Tracker 2025',
    publisher: 'Gupta Media',
    short_name: 'Gupta Media',
    url: 'https://www.guptamedia.com/social-media-ads-cost',
    period: '2025 (monthly refresh)',
    methodology: 'Tens of billions of ad impressions; social CPM seasonality',
    tier: 'premium',
    confidence: 'verified'
  },
  gupta_instagram_2025: {
    label: 'Gupta Media Instagram Ads Cost 2025',
    publisher: 'Gupta Media',
    short_name: 'Gupta Instagram',
    url: 'https://www.guptamedia.com/insights/instagram-ads-cost',
    period: 'June 2025',
    methodology: 'Platform and format-level Instagram cost metrics',
    tier: 'premium',
    confidence: 'verified'
  },
  gupta_snapchat_2025: {
    label: 'Gupta Media Snapchat Ads Cost 2025',
    publisher: 'Gupta Media',
    short_name: 'Gupta Snapchat',
    url: 'https://www.guptamedia.com/insights/snapchat-ads-cost',
    period: 'June 2025',
    methodology: 'Platform-level Snapchat cost metrics',
    tier: 'standard',
    confidence: 'verified'
  },
  triplewhale_tiktok_2025: {
    label: 'Triple Whale TikTok Ads Benchmarks 2025',
    publisher: 'Triple Whale',
    short_name: 'Triple Whale TikTok',
    url: 'https://www.triplewhale.com/blog/tiktok-benchmarks',
    period: '2025',
    methodology: 'Ecommerce benchmark perspective for D2C verticals',
    tier: 'standard',
    confidence: 'derived'
  },
  adbacklog_reddit_2025: {
    label: 'AdBacklog Reddit Ads Benchmarks 2025',
    publisher: 'AdBacklog',
    short_name: 'AdBacklog Reddit',
    url: 'https://adbacklog.com/blog/reddit-ads-benchmarks-per-industry-2025',
    period: '2025',
    methodology: 'Directional Reddit benchmarks',
    tier: 'standard',
    confidence: 'estimated'
  },
  funnel_pinterest_2025: {
    label: 'Funnel.io Pinterest Advertising Guide 2025',
    publisher: 'Funnel.io',
    short_name: 'Funnel.io Pinterest',
    url: 'https://funnel.io/blog/pinterest-advertising',
    period: '2025',
    methodology: 'Survey of 270 advertisers for CPC and CPM ranges',
    tier: 'standard',
    confidence: 'derived'
  },
  growthchannel_cpm_2025: {
    label: 'Growth Channel 2025 CPMs by Channel',
    publisher: 'Growth Channel',
    short_name: 'Growth Channel',
    url: 'https://www.growthchannel.com/blog/2025-cpms-by-channel-what-ctv-dooh-and-audio-really-cost',
    period: '2025',
    methodology: 'CTV, DOOH, Audio CPM ranges',
    tier: 'standard',
    confidence: 'derived'
  },
  iab_internet_ad_revenue_2025: {
    label: 'IAB / PwC Internet Advertising Revenue Report 2025',
    publisher: 'IAB / PwC',
    short_name: 'IAB / PwC',
    url: 'https://www.iab.com/insights/internet-advertising-revenue-report/',
    period: 'Full Year 2025',
    methodology: 'US digital ad spend by channel, format, growth trend',
    tier: 'premium',
    confidence: 'verified'
  },
  adamigo_meta_regional_2026: {
    label: 'Adamigo 2026 Meta Ads Regional Cost Report',
    publisher: 'Adamigo',
    short_name: 'Adamigo Regional',
    url: 'https://adamigo.io/blog/meta-ads-regional-costs-2026',
    period: '2026',
    methodology: 'Regional Meta CPM/CPC variation by country tier',
    tier: 'standard',
    confidence: 'derived'
  }
};

// In-memory state overwritten by /api/refresh-benchmarks.
let lastRefreshed = 'May 2026 (verified 2025 dataset)';
let refreshSource = 'manual-csv';

// =============================================================
// BENCHMARK DATABASE
// Per channel: cpc ($), cpm ($), ctr (%), cvr (%), cpa ($)
// null = source data unavailable or metric does not apply.
// =============================================================
const BENCHMARKS = {
  ecommerce: {
    label: 'E-Commerce & Retail',
    channels: {
      google_search: { cpc: 3.49, ctr: 8.92, cvr: 2.81, cpm: null, cpa: 47.94 },
      google_display: { cpc: 0.67, ctr: 0.46, cvr: 0.84, cpm: 2.80, cpa: 65.00 },
      meta: { cpc: 0.34, ctr: 1.50, cvr: 1.90, cpm: 12.50, cpa: 38.00 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 1.90, cpm: 8.16, cpa: 38.00 },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 },
      youtube: { cpc: 0.49, ctr: 0.65, cvr: 0.60, cpm: 7.50, cpa: 80.00 },
      programmatic: { cpc: 0.80, ctr: 0.35, cvr: 0.50, cpm: 3.50, cpa: 90.00 },
      pinterest: { cpc: 0.80, ctr: null, cvr: null, cpm: 3.50, cpa: null }
    },
    kpi_targets: { roas: 4.0, blended_cac: 45, repeat_purchase_rate: '25-35%' },
    seasonal_notes: 'Peak: Nov-Dec (Q4 holiday). Secondary: Back-to-school (Aug), Valentine\'s Day (Feb), Mother\'s Day (May).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'gupta_instagram_2025', 'triplewhale_tiktok_2025', 'funnel_pinterest_2025']
  },

  apparel_fashion: {
    label: 'Apparel & Fashion',
    channels: {
      google_search: { cpc: 4.31, ctr: 6.77, cvr: 3.99, cpm: null, cpa: 101.49 },
      google_display: { cpc: 0.55, ctr: 0.50, cvr: 0.90, cpm: 2.50, cpa: 50.00 },
      meta: { cpc: 0.86, ctr: null, cvr: null, cpm: 13.00, cpa: null },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: null, cpm: 8.16, cpa: null },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 },
      youtube: { cpc: 0.50, ctr: 0.70, cvr: 0.65, cpm: 8.00, cpa: 75.00 },
      pinterest: { cpc: 0.80, ctr: null, cvr: null, cpm: 3.50, cpa: null }
    },
    kpi_targets: { roas: 3.8, aov: 85, return_rate: '15-25%' },
    seasonal_notes: 'Peaks: Black Friday/Cyber Monday, Valentine\'s Day, back-to-school, prom season.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'gupta_instagram_2025', 'triplewhale_tiktok_2025', 'funnel_pinterest_2025']
  },

  beauty_personal_care: {
    label: 'Beauty & Personal Care',
    channels: {
      google_search: { cpc: 5.70, ctr: 5.71, cvr: 7.82, cpm: null, cpa: 60.34 },
      google_display: { cpc: 0.65, ctr: 0.50, cvr: 0.85, cpm: 3.00, cpa: 55.00 },
      meta: { cpc: 3.06, ctr: 2.55, cvr: 5.29, cpm: 14.00, cpa: 51.42 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 5.29, cpm: 8.16, cpa: 51.42 },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 },
      youtube: { cpc: 0.55, ctr: 0.75, cvr: 0.70, cpm: 8.50, cpa: 80.00 },
      pinterest: { cpc: 0.80, ctr: null, cvr: null, cpm: 3.50, cpa: null }
    },
    kpi_targets: { roas: 3.6, blended_cac: 38, repeat_purchase_rate: '30-40%' },
    seasonal_notes: 'Q4 gift-giving (Nov-Dec), Mother\'s Day (May), summer skincare (Jun-Aug).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'gupta_instagram_2025', 'triplewhale_tiktok_2025', 'funnel_pinterest_2025']
  },

  legal: {
    label: 'Legal Services',
    channels: {
      google_search: { cpc: 8.58, ctr: 5.97, cvr: 5.09, cpm: null, cpa: 131.63 },
      google_display: { cpc: 2.00, ctr: 0.35, cvr: 1.50, cpm: 5.00, cpa: 120.00 },
      meta: { cpc: 4.10, ctr: 2.11, cvr: 10.53, cpm: 18.00, cpa: 18.17 },
      youtube: { cpc: 0.70, ctr: 0.55, cvr: 0.80, cpm: 9.00, cpa: 180.00 },
      linkedin: { cpc: 5.15, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 },
      programmatic: { cpc: 1.50, ctr: 0.30, cvr: 0.70, cpm: 5.50, cpa: 200.00 }
    },
    kpi_targets: { lead_cost_target: 75, consultation_rate: '30-40%', close_rate: '20-30%' },
    seasonal_notes: 'Personal injury peaks post-holiday (Jan) and summer (Jul-Aug). Family law peaks Jan-Feb.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  real_estate: {
    label: 'Real Estate',
    channels: {
      google_search: { cpc: 2.53, ctr: 8.43, cvr: 2.47, cpm: null, cpa: 100.48 },
      google_display: { cpc: 0.88, ctr: 0.40, cvr: 0.80, cpm: 3.50, cpa: 90.00 },
      meta: { cpc: 1.57, ctr: 3.75, cvr: 9.53, cpm: 22.00, cpa: 16.61 },
      instagram: { cpc: 1.40, ctr: 0.80, cvr: 1.50, cpm: 11.00, cpa: 85.00 },
      youtube: { cpc: 0.55, ctr: 0.50, cvr: 0.60, cpm: 8.00, cpa: 130.00 },
      linkedin: { cpc: 5.15, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 },
      programmatic: { cpc: 1.00, ctr: 0.30, cvr: 0.50, cpm: 4.00, cpa: 150.00 }
    },
    kpi_targets: { cost_per_inquiry: 35, inquiry_to_showing: '15-25%' },
    seasonal_notes: 'Spring selling season (Mar-Jun) is peak. Q4 slower as buyers wait for new year.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  healthcare: {
    label: 'Healthcare & Medical',
    channels: {
      google_search: { cpc: 5.00, ctr: 6.73, cvr: 3.36, cpm: null, cpa: 56.83 },
      google_display: { cpc: 1.10, ctr: 0.40, cvr: 1.10, cpm: 4.20, cpa: 110.00 },
      meta: { cpc: 2.23, ctr: 3.02, cvr: 4.51, cpm: 19.50, cpa: 47.47 },
      youtube: { cpc: 0.55, ctr: 0.50, cvr: 0.70, cpm: 8.50, cpa: 145.00 },
      linkedin: { cpc: 5.15, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 },
      programmatic: { cpc: 1.20, ctr: 0.28, cvr: 0.60, cpm: 4.80, cpa: 170.00 }
    },
    kpi_targets: { cost_per_appointment: 85, patient_acquisition_cost: 200 },
    seasonal_notes: 'Jan peaks (new insurance year). Oct-Nov peaks (open enrollment).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  dental: {
    label: 'Dental Services',
    channels: {
      google_search: { cpc: 7.85, ctr: 5.44, cvr: 9.08, cpm: null, cpa: 83.93 },
      google_display: { cpc: 1.10, ctr: 0.45, cvr: 1.30, cpm: 4.50, cpa: 75.00 },
      meta: { cpc: 9.78, ctr: 1.05, cvr: 6.38, cpm: 18.00, cpa: 76.71 },
      youtube: { cpc: 0.60, ctr: 0.55, cvr: 0.85, cpm: 8.00, cpa: 125.00 }
    },
    kpi_targets: { cost_per_appointment: 65, new_patient_acquisition_cost: 150 },
    seasonal_notes: 'Jan (new insurance year, FSA spending), Aug-Sep (back-to-school checkups), year-end (use-it-or-lose-it benefits).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  finance: {
    label: 'Finance & Insurance',
    channels: {
      google_search: { cpc: 3.46, ctr: 8.33, cvr: 2.55, cpm: null, cpa: 83.93 },
      google_display: { cpc: 1.20, ctr: 0.40, cvr: 1.60, cpm: 4.90, cpa: 130.00 },
      meta: { cpc: 1.22, ctr: 0.90, cvr: 2.20, cpm: 18.56, cpa: 90.00 },
      linkedin: { cpc: 2.59, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 },
      youtube: { cpc: 0.60, ctr: 0.50, cvr: 0.80, cpm: 9.00, cpa: 190.00 },
      programmatic: { cpc: 1.30, ctr: 0.30, cvr: 0.70, cpm: 5.20, cpa: 210.00 }
    },
    kpi_targets: { cost_per_application: 90, lead_to_customer: '8-15%' },
    seasonal_notes: 'Tax season (Jan-Apr) peak. Insurance open enrollment (Oct-Dec).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'closely_linkedin_2025']
  },

  b2b_saas: {
    label: 'B2B / SaaS / Technology',
    channels: {
      google_search: { cpc: 5.58, ctr: 5.65, cvr: 5.14, cpm: null, cpa: 103.54 },
      google_display: { cpc: 1.50, ctr: 0.35, cvr: 0.60, cpm: 6.00, cpa: 175.00 },
      linkedin: { cpc: 13.10, ctr: 0.89, cvr: 8.00, cpm: 34.50, cpa: 112.50 },
      meta: { cpc: 0.75, ctr: 0.80, cvr: 1.20, cpm: 16.41, cpa: 130.00 },
      youtube: { cpc: 0.65, ctr: 0.45, cvr: 0.50, cpm: 9.50, cpa: 220.00 },
      reddit: { cpc: 1.25, ctr: 0.75, cvr: 2.00, cpm: 4.00, cpa: 75.00 },
      programmatic: { cpc: 1.60, ctr: 0.28, cvr: 0.45, cpm: 6.50, cpa: 280.00 }
    },
    kpi_targets: { cac: 150, mrr_payback_months: 12, free_trial_conversion: '15-25%' },
    seasonal_notes: 'Q1 budget flush (Jan-Mar) and Q4 year-end spend are peaks. Summer (Jul-Aug) slower.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'closely_linkedin_2025', 'hockeystack_linkedin_b2b_2025', 'adbacklog_reddit_2025']
  },

  education: {
    label: 'Education & e-Learning',
    channels: {
      google_search: { cpc: 6.23, ctr: 5.74, cvr: 11.38, cpm: null, cpa: 90.02 },
      google_display: { cpc: 0.90, ctr: 0.40, cvr: 1.00, cpm: 3.80, cpa: 100.00 },
      meta: { cpc: 1.65, ctr: 1.86, cvr: 10.08, cpm: 10.00, cpa: 28.22 },
      youtube: { cpc: 0.50, ctr: 0.55, cvr: 0.70, cpm: 7.50, cpa: 120.00 },
      tiktok: { cpc: 0.90, ctr: 1.10, cvr: 0.90, cpm: 9.00, cpa: 90.00 },
      programmatic: { cpc: 0.90, ctr: 0.30, cvr: 0.55, cpm: 4.00, cpa: 140.00 }
    },
    kpi_targets: { cost_per_enrollment: 75, completion_rate_target: '60-70%' },
    seasonal_notes: 'Back-to-school (Aug-Sep), New Year resolutions (Jan), Spring enrollment (Mar-Apr).',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  home_services: {
    label: 'Home Services & Trades',
    channels: {
      google_search: { cpc: 7.85, ctr: 6.37, cvr: 7.33, cpm: null, cpa: 90.92 },
      google_display: { cpc: 1.80, ctr: 0.45, cvr: 2.00, cpm: 5.50, cpa: 95.00 },
      meta: { cpc: 2.23, ctr: 1.94, cvr: 5.22, cpm: 17.23, cpa: 41.26 },
      nextdoor: { cpc: 1.20, ctr: 0.80, cvr: 2.00, cpm: 8.00, cpa: 60.00 },
      programmatic: { cpc: 1.40, ctr: 0.32, cvr: 0.80, cpm: 4.50, cpa: 130.00 }
    },
    kpi_targets: { cost_per_booked_job: 70, average_job_value: 350 },
    seasonal_notes: 'Spring (Mar-May) peaks for landscaping, roofing, HVAC. Emergency services year-round.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  automotive: {
    label: 'Automotive',
    channels: {
      google_search: { cpc: 2.41, ctr: 8.29, cvr: 7.76, cpm: null, cpa: 38.86 },
      google_display: { cpc: 0.90, ctr: 0.45, cvr: 0.80, cpm: 3.60, cpa: 80.00 },
      meta: { cpc: 0.79, ctr: 1.00, cvr: 1.60, cpm: 14.00, cpa: 62.00 },
      youtube: { cpc: 0.55, ctr: 0.55, cvr: 0.60, cpm: 8.50, cpa: 100.00 },
      programmatic: { cpc: 1.10, ctr: 0.32, cvr: 0.55, cpm: 4.20, cpa: 130.00 }
    },
    kpi_targets: { cost_per_test_drive: 80, lead_to_sale: '8-15%' },
    seasonal_notes: 'Year-end clearance (Nov-Dec), tax refund season (Feb-Apr), spring (Mar-May) for SUVs/trucks.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  travel: {
    label: 'Travel & Hospitality',
    channels: {
      google_search: { cpc: 2.12, ctr: 8.73, cvr: 3.60, cpm: null, cpa: 73.70 },
      google_display: { cpc: 0.70, ctr: 0.45, cvr: 1.00, cpm: 3.00, cpa: 75.00 },
      meta: { cpc: 0.51, ctr: 1.20, cvr: 1.80, cpm: 12.00, cpa: 48.00 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 1.80, cpm: 8.16, cpa: 48.00 },
      youtube: { cpc: 0.50, ctr: 0.55, cvr: 0.60, cpm: 7.00, cpa: 100.00 },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 },
      programmatic: { cpc: 0.85, ctr: 0.33, cvr: 0.55, cpm: 3.80, cpa: 120.00 }
    },
    kpi_targets: { cost_per_booking: 45, average_trip_value: 1200 },
    seasonal_notes: 'Spring break (Mar-Apr), summer (Jun-Aug), holiday (Dec) are peaks. Shoulder seasons Q1/Q4 for discount travel.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'gupta_instagram_2025']
  },

  restaurant: {
    label: 'Restaurants & Food',
    channels: {
      google_search: { cpc: 2.05, ctr: 7.58, cvr: 5.00, cpm: null, cpa: 30.27 },
      google_display: { cpc: 0.60, ctr: 0.40, cvr: 1.50, cpm: 2.80, cpa: 28.00 },
      meta: { cpc: 0.74, ctr: 2.97, cvr: 18.25, cpm: 8.14, cpa: 3.16 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 18.25, cpm: 8.16, cpa: 3.16 },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 },
      programmatic: { cpc: 0.70, ctr: 0.35, cvr: 0.70, cpm: 3.20, cpa: 40.00 }
    },
    kpi_targets: { local_reach_cpm: 10, repeat_visit_rate: '40%' },
    seasonal_notes: 'High localized intent. Mother\'s Day, Father\'s Day, Valentine\'s, Q4 holidays drive bookings.',
    confidence: 'high',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'gupta_instagram_2025']
  },

  nonprofit: {
    label: 'Nonprofit & Causes',
    channels: {
      google_search: { cpc: 1.43, ctr: 4.83, cvr: 4.29, cpm: null, cpa: 81.40 },
      google_display: { cpc: 0.55, ctr: 0.40, cvr: 1.00, cpm: 2.50, cpa: 95.00 },
      meta: { cpc: 0.80, ctr: 1.10, cvr: 2.00, cpm: 9.00, cpa: 45.00 },
      youtube: { cpc: 0.45, ctr: 0.50, cvr: 0.70, cpm: 6.50, cpa: 110.00 }
    },
    kpi_targets: { cost_per_donor: 45, donor_retention_rate: '40-50%' },
    seasonal_notes: 'Year-end giving (Nov-Dec) is dominant. Giving Tuesday (Nov), tax-deduction push (Dec).',
    confidence: 'medium',
    _sources: []
  },

  arts_entertainment: {
    label: 'Arts & Entertainment',
    channels: {
      google_search: { cpc: 1.60, ctr: 13.10, cvr: 4.84, cpm: null, cpa: 30.27 },
      google_display: { cpc: 0.50, ctr: 0.50, cvr: 0.80, cpm: 2.50, cpa: 60.00 },
      meta: { cpc: 1.08, ctr: 3.92, cvr: 9.34, cpm: 9.00, cpa: 18.17 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 9.34, cpm: 8.16, cpa: 18.17 },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 }
    },
    kpi_targets: { cost_per_ticket: 12, ticket_to_attendance: '70-85%' },
    seasonal_notes: 'Summer festival season (Jun-Aug), holiday performances (Nov-Dec), spring touring (Mar-May).',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  sports_recreation: {
    label: 'Sports & Recreation',
    channels: {
      google_search: { cpc: 2.64, ctr: 9.19, cvr: null, cpm: null, cpa: 47.47 },
      google_display: { cpc: 0.60, ctr: 0.50, cvr: 0.90, cpm: 3.00, cpa: 65.00 },
      meta: { cpc: 1.07, ctr: 3.41, cvr: 5.48, cpm: 11.00, cpa: 19.30 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 5.48, cpm: 8.16, cpa: 19.30 }
    },
    kpi_targets: { cost_per_membership: 60, retention_rate: '60-75%' },
    seasonal_notes: 'New Year fitness surge (Jan), spring outdoor (Mar-May), back-to-fitness Sep.',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  career_employment: {
    label: 'Career & Employment',
    channels: {
      google_search: { cpc: 5.16, ctr: 6.57, cvr: 4.33, cpm: null, cpa: 62.80 },
      google_display: { cpc: 0.80, ctr: 0.40, cvr: 0.95, cpm: 4.00, cpa: 90.00 },
      meta: { cpc: 0.86, ctr: 2.81, cvr: 5.77, cpm: 13.00, cpa: 17.64 },
      linkedin: { cpc: 5.15, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 }
    },
    kpi_targets: { cost_per_application: 18, application_to_hire: '5-10%' },
    seasonal_notes: 'Q1 hiring surge (Jan-Mar), back-to-work (Aug-Sep), seasonal hiring (Oct-Nov retail).',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'closely_linkedin_2025']
  },

  furniture: {
    label: 'Furniture & Home Goods',
    channels: {
      google_search: { cpc: 3.86, ctr: 6.11, cvr: 2.73, cpm: null, cpa: 121.51 },
      google_display: { cpc: 0.65, ctr: 0.45, cvr: 0.85, cpm: 3.20, cpa: 70.00 },
      meta: { cpc: 2.18, ctr: 1.48, cvr: 3.77, cpm: 13.50, cpa: 40.04 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 3.77, cpm: 8.16, cpa: 40.04 },
      pinterest: { cpc: 0.80, ctr: null, cvr: null, cpm: 3.50, cpa: null }
    },
    kpi_targets: { roas: 3.5, aov: 450, return_rate: '8-15%' },
    seasonal_notes: 'President\'s Day, Memorial Day, Labor Day, Black Friday major sale windows.',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'funnel_pinterest_2025']
  },

  industrial_commercial: {
    label: 'Industrial & Commercial',
    channels: {
      google_search: { cpc: 5.70, ctr: 6.23, cvr: null, cpm: null, cpa: 85.63 },
      google_display: { cpc: 1.20, ctr: 0.35, cvr: 0.80, cpm: 5.00, cpa: 140.00 },
      meta: { cpc: 1.80, ctr: 2.08, cvr: 9.34, cpm: 14.50, cpa: 37.34 },
      linkedin: { cpc: 5.15, ctr: 0.50, cvr: 8.00, cpm: 34.50, cpa: 112.50 }
    },
    kpi_targets: { cost_per_lead: 120, lead_to_quote: '15-25%' },
    seasonal_notes: 'Q1 budget cycles, Q4 year-end procurement, industry trade show windows (varies).',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025', 'closely_linkedin_2025']
  },

  personal_services: {
    label: 'Personal Services',
    channels: {
      google_search: { cpc: 5.81, ctr: 7.69, cvr: null, cpm: null, cpa: 53.52 },
      google_display: { cpc: 0.70, ctr: 0.40, cvr: 1.00, cpm: 3.00, cpa: 65.00 },
      meta: { cpc: 2.08, ctr: 1.99, cvr: 6.51, cpm: 11.00, cpa: 30.57 },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: 6.51, cpm: 8.16, cpa: 30.57 }
    },
    kpi_targets: { cost_per_booking: 30, repeat_visit_rate: '50-65%' },
    seasonal_notes: 'Wedding season (May-Oct), holidays (Nov-Dec), summer (Jun-Aug) for outdoor services.',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  animals_pets: {
    label: 'Animals & Pets',
    channels: {
      google_search: { cpc: 3.97, ctr: 6.58, cvr: 13.07, cpm: null, cpa: 31.82 },
      google_display: { cpc: 0.55, ctr: 0.45, cvr: 0.95, cpm: 2.80, cpa: 55.00 },
      meta: { cpc: 0.78, ctr: null, cvr: null, cpm: 9.50, cpa: null },
      instagram: { cpc: 0.69, ctr: 1.19, cvr: null, cpm: 8.16, cpa: null },
      tiktok: { cpc: null, ctr: null, cvr: 2.01, cpm: 13.26, cpa: 32.74 }
    },
    kpi_targets: { roas: 3.2, blended_cac: 35, repeat_purchase_rate: '40-55%' },
    seasonal_notes: 'Pet adoption surge spring/summer, holiday gifting (Nov-Dec), summer (Jun-Aug) for outdoor pet products.',
    confidence: 'medium',
    _sources: ['localiq_search_2025', 'localiq_facebook_2025']
  },

  default: {
    label: 'General / Cross-Industry',
    channels: {
      google_search: { cpc: 2.69, ctr: 3.17, cvr: 3.75, cpm: null, cpa: 48.96 },
      google_display: { cpc: 0.80, ctr: 0.40, cvr: 0.90, cpm: 3.50, cpa: 90.00 },
      meta: { cpc: 1.20, ctr: 1.00, cvr: 1.80, cpm: 12.00, cpa: 65.00 },
      instagram: { cpc: 1.00, ctr: 0.80, cvr: 1.30, cpm: 9.00, cpa: 80.00 },
      linkedin: { cpc: 7.50, ctr: 0.55, cvr: 1.20, cpm: 35.00, cpa: 200.00 },
      youtube: { cpc: 0.55, ctr: 0.50, cvr: 0.60, cpm: 8.00, cpa: 130.00 },
      tiktok: { cpc: 0.95, ctr: 1.05, cvr: 1.00, cpm: 9.50, cpa: 70.00 },
      programmatic: { cpc: 1.00, ctr: 0.30, cvr: 0.60, cpm: 4.00, cpa: 140.00 }
    },
    kpi_targets: {},
    seasonal_notes: 'No industry-specific seasonality applied. Review with client.',
    confidence: 'medium',
    _sources: []
  }
};

// =============================================================
// REGIONAL_RATE_MULTIPLIERS
// Adjusts US baseline rates (CPC, CPM, CPA) for non-US markets.
// Source: Adamigo 2026 Meta Ads Regional Cost Report.
// =============================================================
const REGIONAL_RATE_MULTIPLIERS = {
  us: { cpm: 1.00, cpc: 1.00, tier: 1, label: 'United States' },
  au: { cpm: 0.80, cpc: 0.78, tier: 1, label: 'Australia' },
  ca: { cpm: 0.58, cpc: 0.65, tier: 1, label: 'Canada' },
  sg: { cpm: 0.52, cpc: 0.67, tier: 1, label: 'Singapore' },
  uk: { cpm: 0.45, cpc: 0.72, tier: 1, label: 'United Kingdom' },
  de: { cpm: 0.44, cpc: 0.54, tier: 2, label: 'Germany' },
  uae: { cpm: 0.28, cpc: 0.52, tier: 2, label: 'United Arab Emirates' },
  in: { cpm: 0.11, cpc: 0.07, tier: 3, label: 'India' }
};

function resolveRegionCode(locationString) {
  if (!locationString) return 'us';
  const lower = String(locationString).toLowerCase();
  if (lower.includes('united states') || lower.includes('usa') || lower === 'us') return 'us';
  if (lower.includes('australia')) return 'au';
  if (lower.includes('canada')) return 'ca';
  if (lower.includes('singapore')) return 'sg';
  if (lower.includes('united kingdom') || lower.includes(' uk') || lower.endsWith('uk')) return 'uk';
  if (lower.includes('germany') || lower.includes('deutschland')) return 'de';
  if (lower.includes('united arab') || lower.includes('uae') || lower.includes('dubai')) return 'uae';
  if (lower.includes('india')) return 'in';
  return 'us';
}

// =============================================================
// INDUSTRY KEY RESOLVER
// Maps free-text industry input to a BENCHMARKS key.
// Specific keys are deliberately ordered before broad keys.
// =============================================================
const INDUSTRY_KEYWORDS = {
  dental: ['dental', 'dentist', 'orthodontist', 'orthodontics', 'oral surgery', 'pediatric dentist'],
  apparel_fashion: ['apparel', 'clothing', 'fashion', 'jewelry', 'jewellery', 'accessories', 'shoes', 'footwear', 'handbags'],
  beauty_personal_care: ['beauty', 'cosmetics', 'skincare', 'haircare', 'makeup', 'personal care', 'salon', 'spa', 'fragrance', 'perfume'],

  ecommerce: ['ecommerce', 'e-commerce', 'retail', 'shopping', 'online store', 'dtc', 'direct to consumer', 'shopify'],
  legal: ['legal', 'law', 'attorney', 'lawyer', 'law firm', 'litigation', 'personal injury', 'family law'],
  real_estate: ['real estate', 'property', 'realtor', 'realty', 'housing', 'mortgage', 'home buying', 'home selling'],
  healthcare: ['healthcare', 'health', 'medical', 'clinic', 'hospital', 'pharmacy', 'wellness', 'telehealth', 'medspa', 'physician'],
  finance: ['finance', 'financial', 'insurance', 'banking', 'investment', 'fintech', 'accounting', 'tax', 'credit', 'lending'],
  b2b_saas: ['saas', 'software', 'b2b', 'technology', 'tech', 'platform', 'enterprise', 'crm', 'erp', 'cloud'],
  education: ['education', 'e-learning', 'elearning', 'online course', 'university', 'tutoring', 'training', 'edtech', 'school'],
  home_services: ['home services', 'home improvement', 'plumbing', 'hvac', 'roofing', 'landscaping', 'cleaning', 'pest control', 'electrician', 'contractor'],
  automotive: ['automotive', 'auto', 'car', 'vehicle', 'dealership', 'car wash', 'auto repair'],
  travel: ['travel', 'hospitality', 'hotel', 'tourism', 'airline', 'vacation', 'tour', 'booking', 'resort'],
  restaurant: ['restaurant', 'food', 'beverage', 'cafe', 'coffee', 'dining', 'delivery', 'catering', 'bakery', 'bar'],
  nonprofit: ['nonprofit', 'non-profit', 'ngo', 'charity', 'foundation', 'fundraising', 'cause', 'advocacy'],
  arts_entertainment: ['arts', 'entertainment', 'music', 'concert', 'theater', 'theatre', 'museum', 'gallery', 'film', 'festival'],
  sports_recreation: ['sports', 'recreation', 'gym', 'fitness club', 'yoga studio', 'athletics', 'sporting goods'],
  career_employment: ['career', 'employment', 'job board', 'recruitment', 'recruiting', 'staffing', 'hiring'],
  furniture: ['furniture', 'home furnishing', 'home goods', 'mattress', 'bedding', 'home decor'],
  industrial_commercial: ['industrial', 'manufacturing', 'commercial', 'b2b services', 'wholesale', 'logistics'],
  personal_services: ['photographer', 'event planner', 'wedding planner', 'tailor', 'tutor private', 'massage therapist'],
  animals_pets: ['pet', 'pets', 'veterinary', 'veterinarian', 'animal', 'dog', 'cat', 'pet store']
};

function resolveIndustryKey(industryString) {
  if (!industryString) return 'default';
  const lower = String(industryString).toLowerCase();

  if (BENCHMARKS[lower]) return lower;
  if (lower === 'beauty_fashion' || lower === 'beauty & fashion') return 'beauty_personal_care';

  for (const [key, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return key;
  }

  return 'default';
}

// =============================================================
// BUILD PROMPT BLOCK - RULE 17
// =============================================================
function buildBenchmarkPromptBlock(industryString) {
  const key = resolveIndustryKey(industryString);
  const data = BENCHMARKS[key];

  const sourceList = (data._sources || [])
    .map(sid => BENCHMARK_SOURCES[sid])
    .filter(Boolean)
    .map(s => s.short_name)
    .join(', ');
  const sourceListDisplay = sourceList || 'WordStream/LocaliQ baseline';

  let block = `\nRULE 17 - INDUSTRY BENCHMARK ANCHORS (${data.label}):\n`;
  block += `Sources: ${sourceListDisplay} | Refreshed: ${lastRefreshed} | Confidence: ${data.confidence.toUpperCase()}\n\n`;
  block += `HOW TO USE THESE BENCHMARKS:\n`;
  block += `These rates are ANCHOR POINTS from verified US-market publishers (${sourceListDisplay}). `;
  block += `They reflect typical campaigns in average conditions: average geography, average competition, `;
  block += `average creative quality, average season. They are NOT the final answer.\n\n`;
  block += `Your job is to REASON from these anchors using the brand-specific signals available to you `;
  block += `(website intel, competitive intel, keyword data, planning signals from RULE 20). `;
  block += `Anchors are approximately right for the typical case and approximately wrong for any specific brand. `;
  block += `When the context contradicts the anchor, TRUST the context.\n\n`;
  block += `INDUSTRY/CONTEXT ADJUSTMENTS (RULE 17 scope):\n`;
  block += `  ADJUST UPWARD (higher CPC / lower CVR) when:\n`;
  block += `    - Targeting highly competitive sub-niches or premium keywords\n`;
  block += `    - Campaign geography is an expensive DMA (NYC, SF, LA, Chicago, Boston)\n`;
  block += `    - Audience is a narrow B2B decision-maker segment\n`;
  block += `    - Campaign objective is non-branded demand generation\n`;
  block += `    - Company is small with no brand recognition\n`;
  block += `    - Q4 retail / seasonal peak window\n\n`;
  block += `  ADJUST DOWNWARD (lower CPC / higher CVR) when:\n`;
  block += `    - Targeting lower-competition long-tail or local keywords\n`;
  block += `    - Geography is a mid-tier or rural US market\n`;
  block += `    - Campaign is retargeting or branded search (strong intent)\n`;
  block += `    - Brand has strong existing awareness or organic presence\n`;
  block += `    - Off-peak season for the vertical\n\n`;
  block += `COORDINATION WITH RULE 20 (CAMPAIGN INTELLIGENCE CALIBRATION):\n`;
  block += `  If RULE 20 provides a competitive_pressure rate adjustment (e.g. "+15%"), apply it `;
  block += `  ON TOP of RULE 17 adjustments. RULE 17 = industry/geography/seasonality. RULE 20 = `;
  block += `  evidence-based pressure from observed competitor ad activity. They layer.\n\n`;
  block += `INTERNATIONAL MARKETS:\n`;
  block += `  US baseline rates listed below are calibrated for US campaigns. For non-US markets, `;
  block += `  apply these directional adjustments (the prompt will receive the specific country if relevant):\n`;
  block += `    United Kingdom: CPC ~0.72x, CPM ~0.45x of US baseline\n`;
  block += `    Australia: CPC ~0.78x, CPM ~0.80x\n`;
  block += `    Canada: CPC ~0.65x, CPM ~0.58x\n`;
  block += `    Singapore: CPC ~0.67x, CPM ~0.52x\n`;
  block += `    Germany: CPC ~0.54x, CPM ~0.44x\n`;
  block += `    UAE / Dubai: CPC ~0.52x, CPM ~0.28x (but high purchasing power, AOV justifies premium creative)\n`;
  block += `    India: CPC ~0.07x, CPM ~0.11x (very low rates but lower-quality traffic; budget for volume not efficiency)\n`;
  block += `  For other markets, search-verify rates for the specific country.\n\n`;
  block += `BASELINE RATES - ${data.label} (US, typical conditions):\n`;

  for (const [channel, rates] of Object.entries(data.channels)) {
    const label = channel.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const parts = [];
    if (rates.cpc !== null) parts.push(`CPC: $${rates.cpc}`);
    if (rates.cpm !== null) parts.push(`CPM: $${rates.cpm}`);
    if (rates.ctr !== null) parts.push(`CTR: ${rates.ctr}%`);
    if (rates.cvr !== null) parts.push(`CVR: ${rates.cvr}%`);
    if (rates.cpa !== null) parts.push(`CPA: $${rates.cpa}`);
    block += `  ${label}: ${parts.join(' | ')}\n`;
  }

  if (data.kpi_targets && Object.keys(data.kpi_targets).length > 0) {
    block += `\nKPI TARGETS FOR THIS VERTICAL:\n`;
    for (const [kpi, val] of Object.entries(data.kpi_targets)) {
      block += `  ${kpi.replace(/_/g, ' ')}: ${val}\n`;
    }
  }

  if (data.seasonal_notes) {
    block += `\nSEASONALITY: ${data.seasonal_notes}\n`;
  }

  const baselineChannels = new Set(Object.keys(data.channels));
  const candidateExtraChannels = ['ctv', 'ott', 'dooh', 'audio', 'reddit', 'amazon_ads', 'snapchat', 'x_twitter', 'spotify'];
  const channelsNeedingSearch = candidateExtraChannels.filter(c => !baselineChannels.has(c));
  if (channelsNeedingSearch.length > 0) {
    const channelDisplay = channelsNeedingSearch.map(c => c.replace(/_/g, ' ').toUpperCase()).join(', ');
    block += `\nFOR CHANNELS NOT IN THE BASELINE ABOVE (${channelDisplay}, DSPs, programmatic deal types):\n`;
    block += `  - Use your Search grounding capability to look up current benchmark rates BEFORE assigning any CPM, CPC, or CTR.\n`;
    block += `  - Search specifically for: "[platform] average CPM 2025 2026", "[platform] advertising benchmark [industry]", `;
    block += `"IAB programmatic CPM benchmark 2025", "eMarketer CTV CPM 2025", "Basis Technologies programmatic benchmark report".\n`;
    block += `  - Label rates sourced this way as "search-verified estimate" in the plan output.\n`;
    block += `  - If Search returns a range, use the midpoint and note the range.\n`;
    block += `  - If Search returns no usable result, state "market rate - verify with platform" rather than inventing a number.\n`;
    block += `  - For programmatic specifically, distinguish open auction vs PMP vs programmatic direct.\n\n`;
  }

  block += `\nCONSISTENCY REQUIREMENT: Whatever rates you choose for a channel, use the SAME rates `;
  block += `consistently across ALL sections of this plan (Section 05 budget, Section 09 channel detail, `;
  block += `Section 16 benchmarks). Do not use $${data.channels.google_search?.cpc} CPC in `;
  block += `one section and a different CPC for the same channel in another section.\n\n`;
  block += `SECTION 16 RULE: In Section 16 (Industry Benchmark Comparison), the "Industry Average" column `;
  block += `MUST display the BASELINE RATES listed above, NOT the plan's own targets. The "Plan Target" `;
  block += `column shows the rates you chose for THIS campaign (which may be adjusted from the baseline). `;
  block += `The "vs. Benchmark" column compares them. If you adjusted upward, mark "Above avg". `;
  block += `If you adjusted downward, mark "Below avg". If you used baseline exactly, mark "At benchmark". `;
  block += `The two columns MUST show DIFFERENT values when you have adjusted rates for context.\n`;
  return block;
}

// =============================================================
// LAYER 3: Live refresh from WordStream / LocaliQ
// Called by POST /api/refresh-benchmarks
// Attempts to scrape latest published benchmark tables.
// Falls back gracefully if page structure has changed.
// =============================================================
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
      parser: parseWordStreamRates,
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
        log.push(`  x HTTP ${response.status} - skipping`);
        continue;
      }

      const html = await response.text();
      const parsed = parseWordStreamRates(html);

      if (parsed && Object.keys(parsed).length > 0) {
        for (const [industryKey, rates] of Object.entries(parsed)) {
          if (BENCHMARKS[industryKey]) {
            Object.assign(BENCHMARKS[industryKey].channels.google_search, rates);
            updated++;
            log.push(`  Updated ${industryKey}: CPC $${rates.cpc || '?'} | CTR ${rates.ctr || '?'}% | CVR ${rates.cvr || '?'}%`);
          }
        }
      } else {
        log.push('  No parseable rates found (page structure may have changed - manual update needed)');
      }
    } catch (err) {
      log.push(`  Error fetching ${source.label}: ${err.message}`);
    }
  }

  if (updated > 0) {
    lastRefreshed = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    refreshSource = 'auto-scrape';
  }

  return { updated, log, lastRefreshed, refreshSource };
}

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
      if (cpc > 0.10 && cpc < 50 && ctr > 0 && ctr < 30 && cvr > 0 && cvr < 30) {
        results[industryKey] = { ctr, cpc, cvr };
      }
    }
  }

  return results;
}

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
  BENCHMARK_SOURCES,
  REGIONAL_RATE_MULTIPLIERS,
  resolveIndustryKey,
  resolveRegionCode,
  buildBenchmarkPromptBlock,
  refreshBenchmarksFromWeb,
  getBenchmarkMeta,
};
