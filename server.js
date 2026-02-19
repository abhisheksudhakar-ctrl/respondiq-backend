// ═══════════════════════════════════════════════════════════════
// RespondIQ™ v10 — Secure Groq API Proxy + AdTech Intelligence
// Hosted on: Render.com (Web Service)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
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

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'RespondIQ™ Backend v11 (Secure Proxy)', hosting: 'Render.com' });
});

// ── Diagnostic: Check env vars are loaded (no values exposed, just presence) ──
app.get('/api/debug', (req, res) => {
  res.json({
    env_check: {
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      EMAILJS_SERVICE_ID: !!process.env.EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID: !!process.env.EMAILJS_TEMPLATE_ID,
      EMAILJS_PLAN_TEMPLATE_ID: !!process.env.EMAILJS_PLAN_TEMPLATE_ID,
      EMAILJS_PUBLIC_KEY: !!process.env.EMAILJS_PUBLIC_KEY,
      EMAILJS_PRIVATE_KEY: !!process.env.EMAILJS_PRIVATE_KEY,
      FRONTEND_URL: process.env.FRONTEND_URL || '(not set)',
      GOOGLE_SHEETS_WEBHOOK: !!process.env.GOOGLE_SHEETS_WEBHOOK
    },
    cors_origins: ALLOWED_ORIGINS
  });
});

// ── Diagnostic: Fire a test email to see exact EmailJS response ──
app.get('/api/test-email', async (req, res) => {
  try {
    const payload = {
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: 'test@test.com',
        to_name: 'Debug Test',
        otp_code: '000000',
        brand_name: 'RespondIQ Debug'
      }
    };
    console.log('[DEBUG] Sending test email with payload keys:', Object.keys(payload));
    console.log('[DEBUG] service_id:', payload.service_id);
    console.log('[DEBUG] template_id:', payload.template_id);
    console.log('[DEBUG] user_id length:', payload.user_id?.length);
    console.log('[DEBUG] accessToken length:', payload.accessToken?.length);

    const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    res.json({
      emailjs_status: response.status,
      emailjs_response: text,
      diagnosis: response.ok ? '✅ EmailJS is working! Problem is elsewhere.' :
        response.status === 401 ? '❌ PRIVATE_KEY is wrong. Check EmailJS > Account > API Keys.' :
        response.status === 403 ? '❌ SERVICE_ID or PUBLIC_KEY mismatch.' :
        response.status === 422 ? '❌ TEMPLATE_ID is wrong or template variables mismatch.' :
        '❌ Unknown error — check emailjs_response for details.'
    });
  } catch (err) {
    res.json({ error: err.message, diagnosis: '❌ Network error calling EmailJS API from Render server.' });
  }
});

// ══════════════════════════════════════════════════════════════
// MAIN ENDPOINT: /generate-plan
// Handles both initial generation AND plan refinement (Upgrade 4)
// ══════════════════════════════════════════════════════════════
app.post('/generate-plan', async (req, res) => {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('[RespondIQ] GROQ_API_KEY not set in Render environment variables');
    return res.status(500).json({ error: 'API key not configured. Set GROQ_API_KEY in Render > Environment.' });
  }

  try {
    const requestBody = req.body;

    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array required' });
    }

    // ── UPGRADE 4: Refine Plan Logic ──
    // If refine_instruction + current_plan exist, construct a refinement prompt
    if (requestBody.refine_instruction && requestBody.current_plan) {
      console.log('[RespondIQ] Refine request:', requestBody.refine_instruction.substring(0, 80));
      const refinedMessages = [
        {
          role: 'developer',
          content: `You are a senior media strategist. The user has an existing media plan (JSON) and wants changes. Return the FULL updated JSON plan (not a partial diff). Maintain valid math: all budget_pct must sum to 100%, impressions must recalculate from budget changes, and all fields must remain populated. Return ONLY valid JSON — no markdown, no code fences.`
        },
        {
          role: 'user',
          content: `Here is the current media plan JSON:\n\n${JSON.stringify(requestBody.current_plan)}\n\nThe user wants the following change:\n"${requestBody.refine_instruction}"\n\nReturn the FULL updated JSON plan with this change applied. Recalculate all affected numbers (budget splits, impressions, KPIs) to maintain mathematical consistency. Return ONLY the JSON object.`
        }
      ];

      const refineResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: requestBody.model || 'openai/gpt-oss-120b',
          messages: refinedMessages,
          temperature: 0.3,
          max_completion_tokens: Math.min(requestBody.max_completion_tokens || 12000, 16000)
        })
      });

      const refineResult = await refineResponse.json();
      console.log('[RespondIQ] Refine Groq status:', refineResponse.status);
      return res.status(refineResponse.ok ? 200 : refineResponse.status).json(refineResult);
    }

    // ── UPGRADE 1: Website Intelligence with AdTech Scraper ──
    let websiteIntel = { text: '', techStack: [], socialLinks: [] };
    const siteUrl = requestBody.website_url || '';
    if (siteUrl && siteUrl !== 'N/A' && siteUrl.length > 3) {
      try {
        websiteIntel = await scrapeWebsite(siteUrl);
        console.log('[RespondIQ] Scraped:', siteUrl, '|', websiteIntel.text.length, 'chars |',
          'Tech:', websiteIntel.techStack.join(', ') || 'None detected', '|',
          'Social:', websiteIntel.socialLinks.join(', ') || 'None found');
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

        // Tech Stack Detection (Upgrade 1)
        if (websiteIntel.techStack.length) {
          intel += 'TECH STACK DETECTED: ' + websiteIntel.techStack.join(', ') + '\n';
          // Strategic recommendations based on detected pixels
          const hasMetaPixel = websiteIntel.techStack.some(t => t.includes('Meta'));
          const hasGTM = websiteIntel.techStack.some(t => t.includes('GTM'));
          const hasGA4 = websiteIntel.techStack.some(t => t.includes('GA4'));
          const hasLinkedIn = websiteIntel.techStack.some(t => t.includes('LinkedIn'));
          const hasTikTok = websiteIntel.techStack.some(t => t.includes('TikTok'));
          let recs = [];
          if (!hasMetaPixel) recs.push('Meta Pixel is MISSING — recommend installing it for retargeting and Lookalike audiences on Facebook/Instagram.');
          if (!hasGTM) recs.push('Google Tag Manager not detected — recommend implementation for centralized tag management.');
          if (!hasGA4) recs.push('GA4 not detected — recommend GA4 setup for web analytics and conversion tracking.');
          if (!hasLinkedIn && websiteIntel.text.toLowerCase().includes('b2b')) recs.push('LinkedIn Insight Tag missing on a B2B site — recommend for LinkedIn retargeting and lead gen.');
          if (!hasTikTok && websiteIntel.text.toLowerCase().match(/gen\s?z|young|youth|18-24/)) recs.push('TikTok Pixel missing — recommend for younger demographic targeting.');
          if (recs.length) intel += 'TECH STACK RECOMMENDATIONS:\n- ' + recs.join('\n- ') + '\n';
        } else {
          intel += 'TECH STACK: No marketing pixels detected. Recommend installing at minimum: Google Tag Manager, GA4, and Meta Pixel before running any paid campaigns.\n';
        }

        // Social Presence Discovery (Upgrade 1)
        if (websiteIntel.socialLinks.length) {
          intel += 'SOCIAL PRESENCE: ' + websiteIntel.socialLinks.join(', ') + '\n';
          intel += 'Use this to inform channel selection — prioritize platforms where the brand already has a presence.\n';
        } else {
          intel += 'SOCIAL PRESENCE: No social media links found on the website. Consider social channel establishment before heavy ad spend on social platforms.\n';
        }

        intel += '\n' + websiteIntel.text;
        return { role: msg.role, content: msg.content + intel };
      }
      return msg;
    });

    console.log('[RespondIQ] Calling Groq:', requestBody.model || 'openai/gpt-oss-120b');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: requestBody.model || 'openai/gpt-oss-120b',
        messages: messages,
        temperature: requestBody.temperature || 0.4,
        max_completion_tokens: Math.min(requestBody.max_completion_tokens || 12000, 16000)
      })
    });

    const result = await response.json();
    console.log('[RespondIQ] Groq status:', response.status);

    // Attach tech stack + social data so frontend can display it
    if (websiteIntel.techStack.length || websiteIntel.socialLinks.length) {
      result._website_intel = {
        tech_stack: websiteIntel.techStack,
        social_links: websiteIntel.socialLinks
      };
    }

    res.status(response.ok ? 200 : response.status).json(result);
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

  // Merge all results
  let fullText = '';
  if (homepageResult.text) fullText += 'HOMEPAGE:\n' + homepageResult.text + '\n\n';
  if (about.text) fullText += 'ABOUT:\n' + about.text + '\n\n';
  if (services.text) fullText += 'SERVICES:\n' + services.text + '\n\n';

  // Deduplicate tech stack and social links across all pages
  const allTech = [...new Set([
    ...homepageResult.techStack, ...about.techStack, ...services.techStack
  ])];
  const allSocial = [...new Set([
    ...homepageResult.socialLinks, ...about.socialLinks, ...services.socialLinks
  ])];

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

    // ── Extract metadata ──
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) || [])[1] || '';

    // ── UPGRADE 1: Pixel / Tag Detection ──
    const techStack = [];
    // Meta Pixel
    if (/fbevents\.js|fbq\s*\(/i.test(html)) techStack.push('Meta Pixel (Facebook)');
    // Google Tag Manager
    if (/googletagmanager\.com\/gtm\.js/i.test(html)) techStack.push('Google Tag Manager (GTM)');
    // GA4 / gtag
    if (/gtag\/js|googletagmanager\.com\/gtag/i.test(html)) techStack.push('Google Analytics 4 (GA4)');
    // LinkedIn Insight Tag
    if (/snap\.licdn\.com|linkedin\.com\/insight/i.test(html)) techStack.push('LinkedIn Insight Tag');
    // TikTok Pixel
    if (/analytics\.tiktok\.com/i.test(html)) techStack.push('TikTok Pixel');
    // Google Ads conversion
    if (/googleadservices\.com\/pagead\/conversion/i.test(html)) techStack.push('Google Ads Conversion Tag');
    // HubSpot
    if (/js\.hs-scripts\.com|js\.hubspot\.com/i.test(html)) techStack.push('HubSpot Tracking');
    // Hotjar
    if (/static\.hotjar\.com/i.test(html)) techStack.push('Hotjar (Heatmaps)');
    // Segment
    if (/cdn\.segment\.com/i.test(html)) techStack.push('Segment Analytics');
    // Intercom
    if (/widget\.intercom\.io/i.test(html)) techStack.push('Intercom');
    // Drift
    if (/js\.driftt\.com/i.test(html)) techStack.push('Drift Chat');
    // Microsoft Clarity
    if (/clarity\.ms/i.test(html)) techStack.push('Microsoft Clarity');
    // Pinterest Tag
    if (/pintrk\s*\(|s\.pinimg\.com\/ct\/core\.js/i.test(html)) techStack.push('Pinterest Tag');
    // Snapchat Pixel
    if (/sc-static\.net\/scevent\.min\.js/i.test(html)) techStack.push('Snapchat Pixel');
    // Twitter/X Pixel
    if (/static\.ads-twitter\.com/i.test(html)) techStack.push('X (Twitter) Pixel');

    // ── UPGRADE 1: Social Link Discovery ──
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
      const match = html.match(sp.regex);
      if (match) socialLinks.push(sp.name);
    }

    // ── Extract clean text content ──
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
// SECURE EMAIL PROXY: /api/send-email
// Frontend sends email data here; backend calls EmailJS REST API
// All secrets (service ID, keys) stay server-side
// ══════════════════════════════════════════════════════════════
app.post('/api/send-email', async (req, res) => {
  const SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
  const PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

  // Smart Template Routing: map frontend alias → server-side env var
  // Frontend sends 'template_media_plan' or 'template_khu2hlh' as a routing hint
  // Backend resolves it to the REAL template ID from environment variables
  const requestedTemplate = req.body.template_id || '';
  const TEMPLATE_ID = requestedTemplate === 'template_media_plan'
    ? process.env.EMAILJS_PLAN_TEMPLATE_ID
    : process.env.EMAILJS_TEMPLATE_ID;

  if (!SERVICE_ID || !PUBLIC_KEY || !PRIVATE_KEY) {
    console.error('[RespondIQ] EmailJS env vars missing:',
      !SERVICE_ID ? 'EMAILJS_SERVICE_ID' : '',
      !PUBLIC_KEY ? 'EMAILJS_PUBLIC_KEY' : '',
      !PRIVATE_KEY ? 'EMAILJS_PRIVATE_KEY' : '');
    return res.status(500).json({ error: 'Email service not configured. Set EMAILJS_* vars in Render > Environment.' });
  }
  if (!TEMPLATE_ID) {
    console.error('[RespondIQ] Template ID not found for:', requestedTemplate);
    return res.status(500).json({ error: 'Email template not configured. Set EMAILJS_PLAN_TEMPLATE_ID in Render > Environment.' });
  }

  const { template_params } = req.body;
  if (!template_params || !template_params.to_email) {
    return res.status(400).json({ error: 'Missing template_params or to_email' });
  }

  try {
    console.log('[RespondIQ] Sending email via EmailJS to:', template_params.to_email, '| Template:', requestedTemplate === 'template_media_plan' ? 'PLAN' : 'OTP');
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
// Frontend sends lead data here; backend forwards to Google Sheets
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
    console.log('[RespondIQ] Lead forwarded to Google Sheets');
    res.json({ success: true });
  } catch (err) {
    console.error('[RespondIQ] Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Start Server ──
app.listen(PORT, () => {
  console.log(`[RespondIQ] Backend v11 (Secure Proxy) running on port ${PORT}`);
  console.log(`[RespondIQ] CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
