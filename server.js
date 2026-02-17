// ═══════════════════════════════════════════════════════════════
// RespondIQ™ v10 — Secure Groq API Proxy + AdTech Intelligence
// Hosted on: Render.com (Web Service)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'RespondIQ™ Backend v10', hosting: 'Render.com' });
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


// ── Start Server ──
app.listen(PORT, () => {
  console.log(`[RespondIQ] Backend v10 running on port ${PORT} (Render.com)`);
});
