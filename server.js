// ═══════════════════════════════════════════════════════════════
// RespondIQ™ v12 — Gemini 3.1 Pro + Medium Thinking + Search Grounding
// AI Model: gemini-3.1-pro-preview (thinking_level: MEDIUM)
// Hosted on: Render.com (Web Service)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const { getKeywordIdeas, isKeywordServiceConfigured } = require('./keyword-service');

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

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RespondIQ™ Backend v12.2 (Gemini 3.1 Pro + Keyword Planner)',
    model: 'gemini-3.1-pro-preview',
    thinking: 'MEDIUM',
    hosting: 'Render.com'
  });
});

// ── Diagnostic: Check env vars are loaded (no values exposed, just presence) ──
app.get('/api/debug', (req, res) => {
  res.json({
    env_check: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      EMAILJS_SERVICE_ID: !!process.env.EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID: !!process.env.EMAILJS_TEMPLATE_ID,
      EMAILJS_PLAN_TEMPLATE_ID: !!process.env.EMAILJS_PLAN_TEMPLATE_ID,
      EMAILJS_PUBLIC_KEY: !!process.env.EMAILJS_PUBLIC_KEY,
      EMAILJS_PRIVATE_KEY: !!process.env.EMAILJS_PRIVATE_KEY,
      FRONTEND_URL: process.env.FRONTEND_URL || '(not set)',
      GOOGLE_SHEETS_WEBHOOK: !!process.env.GOOGLE_SHEETS_WEBHOOK,
      GOOGLE_ADS_DEVELOPER_TOKEN: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      GOOGLE_ADS_CLIENT_ID: !!process.env.GOOGLE_ADS_CLIENT_ID,
      GOOGLE_ADS_CLIENT_SECRET: !!process.env.GOOGLE_ADS_CLIENT_SECRET,
      GOOGLE_ADS_REFRESH_TOKEN: !!process.env.GOOGLE_ADS_REFRESH_TOKEN,
      GOOGLE_ADS_CUSTOMER_ID: !!process.env.GOOGLE_ADS_CUSTOMER_ID,
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: !!process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      KEYWORD_SERVICE_READY: isKeywordServiceConfigured()
    },
    cors_origins: ALLOWED_ORIGINS
  });
});

// ── Diagnostic: Fire a test email (plan delivery only - OTP flow removed) ──
app.get('/api/test-email', async (req, res) => {
  try {
    const payload = {
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_PLAN_TEMPLATE_ID || process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: 'test@test.com',
        to_name: 'Debug Test',
        brand_name: 'RespondIQ Debug',
        plan_summary: 'This is a test email from the RespondIQ backend.'
      }
    };
    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    res.json({
      emailjs_status: response.status,
      emailjs_response: text,
      diagnosis: response.ok ? 'EmailJS is working!' :
        response.status === 401 ? 'PRIVATE_KEY is wrong.' :
        response.status === 403 ? 'SERVICE_ID or PUBLIC_KEY mismatch.' :
        response.status === 422 ? 'TEMPLATE_ID is wrong or template variables mismatch.' :
        'Unknown error - check emailjs_response for details.'
    });
  } catch (err) {
    res.json({ error: err.message, diagnosis: 'Network error calling EmailJS API from Render server.' });
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

    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array required' });
    }

    // ── REFINE PLAN: User has an existing plan and wants changes ──
    if (requestBody.refine_instruction && requestBody.current_plan) {
      console.log('[RespondIQ] Refine request:', requestBody.refine_instruction.substring(0, 80));

      const refineSystem = `You are a senior media strategist. The user has an existing media plan (JSON) and wants changes.
Return the FULL updated JSON plan (not a partial diff).
Maintain valid math: all budget_pct must sum to 100%, impressions must recalculate from budget changes, and all fields must remain populated.
Return ONLY valid JSON — no markdown, no code fences, no explanation text.`;

      const refineUser = `Here is the current media plan JSON:\n\n${JSON.stringify(requestBody.current_plan)}\n\nThe user wants the following change:\n"${requestBody.refine_instruction}"\n\nReturn the FULL updated JSON plan with this change applied. Recalculate all affected numbers (budget splits, impressions, KPIs) to maintain mathematical consistency. Return ONLY the JSON object.`;

      try {
        const refineText = await callGemini(refineSystem, [], refineUser, { maxOutputTokens: 8192 });
        console.log('[RespondIQ] Refine complete, chars:', refineText.length);

        // Wrap in OpenAI-compatible shape so frontend JSON parsing is unchanged
        return res.json({
          choices: [{ message: { content: refineText } }]
        });
      } catch (err) {
        console.error('[RespondIQ] Refine error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── WEBSITE INTELLIGENCE: Scrape client site for real business context ──
    let websiteIntel = { text: '', techStack: [], socialLinks: [] };
    const siteUrl = requestBody.website_url || '';
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

    // ── Inject Website Intelligence into user message ──
    let messages = requestBody.messages.map(msg => {
      if (msg.role === 'user' && (websiteIntel.text || websiteIntel.techStack.length || websiteIntel.socialLinks.length)) {
        let intel = '\n\n=== WEBSITE INTELLIGENCE (scraped from ' + siteUrl + ') ===\n';
        intel += 'Below is ACTUAL content from the client website. Use this to:\n';
        intel += '1. Understand what the brand ACTUALLY does\n';
        intel += '2. Identify REAL competitive peers matched by service type AND company scale\n';
        intel += '3. Do NOT pick Fortune 500 companies unless the client is Fortune 500\n\n';

        // Social Presence (informs channel selection)
        if (websiteIntel.socialLinks.length) {
          intel += 'SOCIAL PRESENCE DETECTED: ' + websiteIntel.socialLinks.join(', ') + '\n';
          intel += 'Use this to inform channel selection — prioritize platforms where the brand already has a presence.\n';
        } else {
          intel += 'SOCIAL PRESENCE: No social media links found on the website.\n';
        }

        intel += '\n' + websiteIntel.text;
        return { role: msg.role, content: msg.content + intel };
      }
      return msg;
    });

    // ── Extract system instruction and build history for callGemini ──
    const systemMsg = messages.find(m => m.role === 'developer' || m.role === 'system');
    const systemInstruction = systemMsg ? systemMsg.content : '';
    const conversationMsgs = messages.filter(m => m.role !== 'developer' && m.role !== 'system');
    const history = conversationMsgs.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const lastMessage = conversationMsgs[conversationMsgs.length - 1]?.content || '';

    const responseText = await callGemini(systemInstruction, history, lastMessage, {
      maxOutputTokens: 8192
    });

    console.log('[RespondIQ] Gemini response received, chars:', responseText.length);

    // ── Wrap response in OpenAI-compatible shape ──
    // Frontend reads: result.choices[0].message.content — this keeps it unchanged
    const result = {
      choices: [{ message: { content: responseText } }]
    };

    // Attach tech stack + social data so frontend can display it (unchanged from v11)
    if (websiteIntel.techStack.length || websiteIntel.socialLinks.length) {
      result._website_intel = {
        tech_stack: websiteIntel.techStack,
        social_links: websiteIntel.socialLinks
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, {
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
// GOOGLE ADS KEYWORD PLANNER: /api/keyword-ideas
// Returns real search volume, competition, and CPC bid data
// ══════════════════════════════════════════════════════════════
app.post('/api/keyword-ideas', async (req, res) => {
  try {
    if (!isKeywordServiceConfigured()) {
      console.warn('[RespondIQ] Keyword service not configured, returning fallback');
      return res.json({ keywords: [], fallback: true, reason: 'not_configured' });
    }

    const { seedKeywords, pageUrl, location, languageId } = req.body;

    if (!seedKeywords?.length && !pageUrl) {
      return res.status(400).json({ error: 'Provide seedKeywords array or pageUrl' });
    }

    console.log('[RespondIQ] Keyword ideas request | seeds:', seedKeywords?.join(', ') || 'none', '| url:', pageUrl || 'none', '| location:', location || 'US');

    const ideas = await getKeywordIdeas(seedKeywords, pageUrl, location, languageId);

    // Convert micros to dollars for readability
    const formatted = ideas.map(kw => ({
      keyword: kw.keyword,
      avg_monthly_searches: kw.avg_monthly_searches,
      competition: kw.competition,
      competition_index: kw.competition_index,
      low_cpc: '$' + (kw.low_top_of_page_bid_micros / 1_000_000).toFixed(2),
      high_cpc: '$' + (kw.high_top_of_page_bid_micros / 1_000_000).toFixed(2),
    }));

    console.log('[RespondIQ] Returning', formatted.length, 'keyword ideas');
    res.json({ keywords: formatted, fallback: false });

  } catch (err) {
    console.error('[RespondIQ] Keyword API error:', err.message);
    // Graceful fallback: never break the plan generation flow
    res.json({ keywords: [], fallback: true, reason: err.message });
  }
});


// ══════════════════════════════════════════════════════════════
// SECURE EMAIL PROXY: /api/send-email
// All EmailJS secrets stay server-side
// ══════════════════════════════════════════════════════════════
app.post('/api/send-email', async (req, res) => {
  const SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
  const PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

  const requestedTemplate = req.body.template_id || '';
  const TEMPLATE_ID = requestedTemplate === 'template_media_plan'
    ? process.env.EMAILJS_PLAN_TEMPLATE_ID
    : process.env.EMAILJS_TEMPLATE_ID;

  if (!SERVICE_ID || !PUBLIC_KEY || !PRIVATE_KEY) {
    return res.status(500).json({ error: 'Email service not configured. Set EMAILJS_* vars in Render > Environment.' });
  }
  if (!TEMPLATE_ID) {
    return res.status(500).json({ error: 'Email template not configured. Set EMAILJS_PLAN_TEMPLATE_ID in Render > Environment.' });
  }

  const { template_params } = req.body;
  if (!template_params || !template_params.to_email) {
    return res.status(400).json({ error: 'Missing template_params or to_email' });
  }

  try {
    console.log('[RespondIQ] Sending email to:', template_params.to_email,
      '| Template:', requestedTemplate === 'template_media_plan' ? 'PLAN' : 'GENERAL');
    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: SERVICE_ID,
        template_id: TEMPLATE_ID,
        user_id: PUBLIC_KEY,
        accessToken: PRIVATE_KEY,
        template_params: template_params
      })
    });

    const text = await response.text();
    console.log('[RespondIQ] EmailJS response:', response.status, text);

    if (response.ok) {
      res.json({ success: true, message: 'Email sent' });
    } else {
      res.status(response.status).json({ error: 'EmailJS error: ' + text });
    }
  } catch (err) {
    console.error('[RespondIQ] Email send error:', err.message);
    res.status(500).json({ error: err.message });
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


// ── Start Server ──
app.listen(PORT, () => {
  console.log(`[RespondIQ] Backend v12 (Gemini 3.1 Pro | MEDIUM thinking) running on port ${PORT}`);
  console.log(`[RespondIQ] CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
