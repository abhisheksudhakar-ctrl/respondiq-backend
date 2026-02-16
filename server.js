// RespondIQ™ — Secure Groq API Proxy with Website Intelligence
// Render.com compatible Express server

const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'RespondIQ Backend' });
});

// Main API endpoint
app.post('/generate-plan', async (req, res) => {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY not set');
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const requestBody = req.body;

    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array required' });
    }

    // Website Intelligence - scrape client site for business context
    let websiteContext = '';
    const siteUrl = requestBody.website_url || '';
    if (siteUrl && siteUrl !== 'N/A' && siteUrl.length > 3) {
      try {
        websiteContext = await scrapeWebsite(siteUrl);
        console.log('Scraped:', siteUrl, websiteContext.length, 'chars');
      } catch (err) {
        console.warn('Scrape failed:', err.message);
      }
    }

    // Inject website context into user message
    let messages = requestBody.messages.map(msg => {
      if (msg.role === 'user' && websiteContext) {
        return {
          role: msg.role,
          content: msg.content +
            '\n\n=== WEBSITE INTELLIGENCE (scraped from ' + siteUrl + ') ===\n' +
            'Below is ACTUAL content from the client website. Use this to:\n' +
            '1. Understand what the brand ACTUALLY does\n' +
            '2. Identify REAL competitive peers matched by service type AND company scale\n' +
            '3. Do NOT pick Fortune 500 companies unless the client is Fortune 500\n\n' +
            websiteContext
        };
      }
      return msg;
    });

    console.log('Calling Groq:', requestBody.model || 'openai/gpt-oss-120b');

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
    console.log('Groq status:', response.status);

    res.status(response.ok ? 200 : response.status).json(result);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ WEBSITE SCRAPER ============
async function scrapeWebsite(url) {
  if (!url.startsWith('http')) url = 'https://' + url;
  const homepage = await fetchPage(url);
  let about = '', services = '';
  try {
    const base = new URL(url).origin;
    for (const p of ['/about', '/about-us', '/who-we-are', '/company']) {
      try { const t = await fetchPage(base + p); if (t && t.length > 100) { about = t; break; } } catch(e) {}
    }
    for (const p of ['/services', '/what-we-do', '/solutions', '/offerings']) {
      try { const t = await fetchPage(base + p); if (t && t.length > 100) { services = t; break; } } catch(e) {}
    }
  } catch(e) {}
  let out = '';
  if (homepage) out += 'HOMEPAGE:\n' + homepage + '\n\n';
  if (about) out += 'ABOUT:\n' + about + '\n\n';
  if (services) out += 'SERVICES:\n' + services + '\n\n';
  return out.length > 3500 ? out.substring(0, 3500) + '...' : out;
}

async function fetchPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RespondIQ/1.0)', 'Accept': 'text/html' } });
    clearTimeout(t);
    if (!r.ok) return '';
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) || [])[1] || '';
    let text = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
    let out = '';
    if (title) out += 'Title: ' + title + '\n';
    if (desc) out += 'Description: ' + desc + '\n';
    if (text) out += 'Content: ' + text.substring(0, 2000);
    return out;
  } catch(e) { clearTimeout(t); return ''; }
}

app.listen(PORT, () => {
  console.log('RespondIQ backend running on port', PORT);
});
