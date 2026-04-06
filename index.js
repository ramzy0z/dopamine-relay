const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── CORS ────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── CLAUDE PROXY ────────────────────────────────────────────────────────────
app.post('/claude', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_KEY not set' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GENERIC ATTIO PROXY (kept for backwards compatibility) ──────────────────
app.post('/attio', async (req, res) => {
  const { endpoint, method, body } = req.body;
  const ATTIO_KEY = process.env.ATTIO_KEY;
  if (!ATTIO_KEY) return res.status(500).json({ error: 'ATTIO_KEY not set' });
  if (!endpoint || !method) return res.status(400).json({ error: 'Missing endpoint or method' });
  try {
    const response = await fetch('https://api.attio.com' + endpoint, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + ATTIO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI ADVISORY ENGINE ───────────────────────────────────────────────────────
// Readable question + answer map used to build the Claude prompt
const READINESS_QUESTIONS = {
  q1:  { text: 'Financial statements prepared by accountant?',
         opts: { '3':'Fully audited by external firm', '2':'Accountant-prepared, not audited', '1':'In progress', '0':'Internal spreadsheets only' } },
  q2:  { text: 'Customer concentration',
         opts: { '0':'One customer >50% of revenue', '1':'One customer 30-50%', '3':'No single customer >30%' } },
  q3:  { text: 'Outstanding tax, loan or legal issues',
         opts: { '3':'None — everything clean', '1':'Minor issues being resolved', '0':'Significant open issues' } },
  q4:  { text: 'Business continuity without owner (3-month test)',
         opts: { '3':'Yes — strong independent team', '2':'Mostly — some gaps', '1':'Unlikely — key decisions need me', '0':'No — fully dependent on me' } },
  q5:  { text: 'Management team strength',
         opts: { '3':'Strong across key functions', '2':'1-2 good people relied on heavily', '0':'Mostly me and junior staff' } },
  q6:  { text: 'Business processes documented (SOPs)',
         opts: { '3':'Yes — clear SOPs', '1':'Partially', '0':'Not really — lives in people\'s heads' } },
  q7:  { text: 'Revenue that is recurring or under contract',
         opts: { '3':'80%+', '2':'50-80%', '1':'20-50%', '0':'Under 20%' } },
  q8:  { text: 'Top 3 customer tenure',
         opts: { '3':'3+ years', '2':'1-3 years', '1':'Under 1 year', '0':'No repeat customers' } },
  q9:  { text: 'Revenue trend last 2 years',
         opts: { '3':'Growing 20%+ per year', '2':'Growing steadily', '1':'Flat', '0':'Declining or inconsistent' } },
  q10: { text: 'Regulatory standing and licence status',
         opts: { '3':'Fully registered, all licences current', '1':'Mostly — minor gaps to sort', '0':'Not fully — registration gaps exist' } },
  q11: { text: 'Key contracts (customers, suppliers, employees) signed',
         opts: { '3':'All significant contracts signed', '2':'Most — some still informal', '0':'Mostly handshakes and trust' } },
  q12: { text: 'Ownership of IP, brand, software',
         opts: { '3':'Company owns all — clearly registered', '2':'Most — some pending formal transfer', '0':'Unclear — some assets in personal name' } },
  q13: { text: 'Clarity of buyer proposition',
         opts: { '3':'Clear and documented', '2':'Generally clear', '1':'Somewhat clear', '0':'Not defined' } }
};

async function generateAdvisory(answers, companyName, sector, revenueRange, maScore, scoreBand, claudeKey) {
  const answerLines = Object.entries(READINESS_QUESTIONS)
    .filter(([q]) => answers[q] !== undefined && answers[q] !== null)
    .map(([q, def]) => {
      const val = String(answers[q]);
      const label = def.opts[val] || `Value: ${val}`;
      return `  - ${def.text}: ${label}`;
    }).join('\n');

  const prompt = `You are an internal analyst at Dopamine, an M&A advisory firm in the UAE. A potential sell-side client just completed our M&A Readiness assessment. Generate two internal CRM fields — never shown to the client.

COMPANY CONTEXT
Name: ${companyName || 'Unknown'}
Sector: ${sector || 'Not specified'}
Annual Revenue: ${revenueRange || 'Not specified'}
M&A Readiness Score: ${maScore}/100 (${scoreBand})

QUESTIONNAIRE ANSWERS
${answerLines}

TASK 1 — INTERNAL ADVISORY NOTE
Write a frank, direct brief (4-6 sentences) for the Dopamine advisor taking the first call. Synthesise risks and opportunities holistically across all answers — not a list of flags, but a coherent read on the deal. Call out the single biggest deal risk, what needs to be resolved before any buyer introductions, and whether this company is worth prioritising now or in 6-12 months. Be direct. This is internal.

TASK 2 — RECOMMENDED REFERRAL
Based on the answers, identify which specialist partners should be involved. Use only these categories where genuinely warranted:
- Audit / accounting partner (UAE Freezone Service Providers list) — if financials are not accountant-prepared
- Legal / compliance partner — if there are significant outstanding tax or legal issues
- Legal / licensing partner — if registration or licence gaps exist
- IP / legal partner — if IP, brand or software assets are held personally or need transfer
List only referrals that are actually needed. If none are needed, return null.

Respond with ONLY valid JSON, no markdown:
{"recommendedReferral":"<string or null>","internalAdvisoryNote":"<string>"}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error('Claude API ' + r.status);
  const d = await r.json();
  const raw = d.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

// ─── STRUCTURED LEAD SUBMISSION ───────────────────────────────────────────────
const AED_PEG = 3.6725;
const toAed = (usd) => (usd != null && !isNaN(usd)) ? Math.round(Number(usd) * AED_PEG) : null;

const BAND_MAP = {
  'not ready':    'Early',
  'early stage':  'Early',
  'getting there':'Developing',
  'nearly ready': 'Sale Ready',
  'exit ready':   'Market Ready'
};
const normaliseBand = (b) => b ? (BAND_MAP[b.toLowerCase().trim()] || b) : null;

const LEAD_MAGNET_LIST_ID = '60ffc158-8444-4d29-b072-e6ed0c374596';
const SELLER_DB_LIST_ID   = '6c2ea989-a5d7-4257-8d7c-f58268718de9';

app.post('/submit-lead', async (req, res) => {
  const ATTIO_KEY  = process.env.ATTIO_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;
  if (!ATTIO_KEY) return res.status(500).json({ error: 'ATTIO_KEY not set' });

  const {
    companyName, domain, description, sector, geo,
    contactName, contactEmail,
    revenueUsd, ebitdaUsd, ownerSalaryUsd,
    leadSource, revenueRange,
    maScore, scoreBand,
    valuationLowUsd, valuationMidUsd, valuationHighUsd,
    answers,
    // Rule-based fallback values sent by the client
    recommendedReferral: fallbackReferral,
    internalAdvisoryNote: fallbackNote
  } = req.body;

  if (!domain || !domain.trim()) {
    return res.status(400).json({ error: 'domain is required for company deduplication' });
  }

  const revenueAed       = toAed(revenueUsd);
  const ebitdaAed        = toAed(ebitdaUsd);
  const ownerSalaryAed   = toAed(ownerSalaryUsd);
  const valuationLowAed  = toAed(valuationLowUsd);
  const valuationMidAed  = toAed(valuationMidUsd);
  const valuationHighAed = toAed(valuationHighUsd);

  // Generate AI advisory if answers are present (M&A Readiness Tool submissions)
  // Falls back to rule-based values sent by the client if Claude call fails
  let advisoryReferral = fallbackReferral || null;
  let advisoryNote     = fallbackNote     || null;

  if (answers && typeof answers === 'object' && Object.keys(answers).length > 0 && CLAUDE_KEY) {
    try {
      const ai = await generateAdvisory(answers, companyName, sector, revenueRange, maScore, scoreBand, CLAUDE_KEY);
      advisoryReferral = ai.recommendedReferral || null;
      advisoryNote     = ai.internalAdvisoryNote || null;
      console.log('[Advisory] AI generated successfully');
    } catch (e) {
      console.warn('[Advisory] Claude call failed, using rule-based fallback:', e.message);
    }
  }

  const attio = async (endpoint, method, body) => {
    try {
      const r = await fetch('https://api.attio.com' + endpoint, {
        method,
        headers: { 'Authorization': 'Bearer ' + ATTIO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  };

  const log = [];

  try {
    // Step 1: Upsert company record
    const companyValues = { domains: [domain.trim()], name: companyName || '' };
    if (description) companyValues.description = description;
    if (leadSource)  companyValues.lead_source  = [leadSource];

    const upsert = await attio(
      '/v2/objects/companies/records?matching_attribute=domains',
      'PUT',
      { data: { values: companyValues } }
    );
    log.push({ step: 'upsert_company', status: upsert.status, ok: upsert.ok });

    if (!upsert.ok) {
      return res.status(502).json({ error: 'Company upsert failed', detail: upsert.data, log });
    }

    const recordId = upsert.data?.data?.id?.record_id;
    if (!recordId) {
      return res.status(502).json({ error: 'No record ID returned from upsert', log });
    }

    // Step 2: Add to Lead Magnet Inbound list
    const leadMagnetEntryValues = {};
    if (contactName)              leadMagnetEntryValues.owner_name             = contactName;
    if (contactEmail)             leadMagnetEntryValues.owner_email            = contactEmail;
    if (revenueAed != null)       leadMagnetEntryValues.annual_revenue_aed     = revenueAed;
    if (ebitdaAed != null)        leadMagnetEntryValues.ebitda_estimate_aed_5  = ebitdaAed;
    if (valuationLowAed != null)  leadMagnetEntryValues.valuation_low_aed_6    = valuationLowAed;
    if (valuationMidAed != null)  leadMagnetEntryValues.valuation_mid_aed      = valuationMidAed;
    if (valuationHighAed != null) leadMagnetEntryValues.valuation_high_aed     = valuationHighAed;
    if (maScore != null)          leadMagnetEntryValues.m_a_readiness_score    = maScore;
    if (scoreBand)                leadMagnetEntryValues.readiness_band         = normaliseBand(scoreBand);
    if (ownerSalaryAed != null)   leadMagnetEntryValues.owner_salary           = ownerSalaryAed;
    if (advisoryReferral)         leadMagnetEntryValues.recommended_referral   = advisoryReferral;
    if (advisoryNote)             leadMagnetEntryValues.internal_advisory_note = advisoryNote;

    const lmEntry = await attio(
      '/v2/lists/' + LEAD_MAGNET_LIST_ID + '/entries',
      'POST',
      { data: { parent_record_id: recordId, parent_object: 'companies', entry_values: leadMagnetEntryValues } }
    );
    const lmOk = lmEntry.ok || lmEntry.status === 409;
    log.push({ step: 'lead_magnet_list', status: lmEntry.status, ok: lmOk });

    // Step 3: Add to Seller Database list
    const sellerEntryValues = {};
    if (revenueAed != null)  sellerEntryValues.estimated_annual_revenue_aed = revenueAed;
    if (ebitdaAed != null)   sellerEntryValues.estimated_ebitda_aed         = ebitdaAed;
    if (contactName)         sellerEntryValues.contact_person_owner         = contactName;
    if (contactEmail)        sellerEntryValues.reach_out_email              = contactEmail;

    const sellerEntry = await attio(
      '/v2/lists/' + SELLER_DB_LIST_ID + '/entries',
      'POST',
      { data: { parent_record_id: recordId, parent_object: 'companies', entry_values: sellerEntryValues } }
    );
    const sellerOk = sellerEntry.ok || sellerEntry.status === 409;
    log.push({ step: 'seller_db_list', status: sellerEntry.status, ok: sellerOk });

    res.json({
      ok: true,
      recordId,
      aed: { revenueAed, ebitdaAed, valuationLowAed, valuationMidAed, valuationHighAed },
      advisory: { referral: advisoryReferral, note: advisoryNote },
      log
    });

  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
});

// ─── SERVER ──────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => console.log('Dopamine relay running'));
