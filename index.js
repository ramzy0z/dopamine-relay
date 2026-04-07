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

  // Attio helper -- omits body for GET requests
  const attio = async (endpoint, method, body) => {
    try {
      const opts = {
        method,
        headers: { 'Authorization': 'Bearer ' + ATTIO_KEY, 'Content-Type': 'application/json' }
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = await fetch('https://api.attio.com' + endpoint, opts);
      return { ok: r.ok, status: r.status, data: await r.json() };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  };

  const log = [];

  try {
    // ── Step 1: Query existing company record to read current lead_source ──────
    // FIX 1: Attio record queries require POST .../records/query with a JSON body.
    // The previous attempt used a GET with query params -- that always returned
    // zero results, so existingLeadSources was always empty and the upsert always
    // overwrote lead_source with only the new single value.
    let existingLeadSources = [];

    const queryCompany = await attio(
      '/v2/objects/companies/records/query',
      'POST',
      { filter: { domains: { domain: { $eq: domain.trim() } } }, limit: 1 }
    );

    if (queryCompany.ok && queryCompany.data?.data?.length > 0) {
      const existing = queryCompany.data.data[0];
      const lsAttr = existing.values?.lead_source;
      if (Array.isArray(lsAttr)) {
        existingLeadSources = lsAttr
          .map(v => v?.option?.title || v?.value || null)
          .filter(Boolean);
      }
    }
    log.push({ step: 'fetch_existing_lead_source', found: existingLeadSources });

    // Merge: add new value only if not already present
    const mergedLeadSources = leadSource
      ? Array.from(new Set([...existingLeadSources, leadSource]))
      : existingLeadSources;

    // ── Step 2: Upsert company record ─────────────────────────────────────────
    const companyValues = { domains: [domain.trim()], name: companyName || '' };
    if (description)               companyValues.description = description;
    if (mergedLeadSources.length)  companyValues.lead_source = mergedLeadSources;

    const upsert = await attio(
      '/v2/objects/companies/records?matching_attribute=domains',
      'PUT',
      { data: { values: companyValues } }
    );
    log.push({ step: 'upsert_company', status: upsert.status, ok: upsert.ok });

    if (!upsert.ok) {
      return res.status(502).json({ error: 'Company upsert failed', detail: upsert.data, log });
    }

    // Chain all known record_id paths to handle new vs existing response shapes
    const recordId =
      upsert.data?.data?.id?.record_id ||
      upsert.data?.data?.record_id      ||
      upsert.data?.id?.record_id        ||
      null;

    if (!recordId) {
      return res.status(502).json({ error: 'No record ID returned from upsert', log });
    }

    // ── Step 3: Fetch all list entries for this company record ─────────────────
    // FIX 2: Use GET /v2/objects/companies/records/{record_id}/entries which returns
    // all list memberships for this record. Filter client-side by list_id.
    // The previous /entries/query approach with { filter: { parent_record_id } }
    // is not a valid Attio filter key and silently returned empty results every
    // time, so the code always fell through to POST and created duplicate entries.
    let existingLmEntryId     = null;
    let existingSellerEntryId = null;

    const allEntries = await attio(
      '/v2/objects/companies/records/' + recordId + '/entries',
      'GET',
      undefined
    );
    log.push({ step: 'fetch_record_entries', status: allEntries.status, ok: allEntries.ok });

    if (allEntries.ok && Array.isArray(allEntries.data?.data)) {
      for (const entry of allEntries.data.data) {
        if (entry.list_id === LEAD_MAGNET_LIST_ID && !existingLmEntryId) {
          existingLmEntryId = entry.entry_id;
        }
        if (entry.list_id === SELLER_DB_LIST_ID && !existingSellerEntryId) {
          existingSellerEntryId = entry.entry_id;
        }
      }
    }

    // ── Step 4: Fetch full entry details to check existing revenue values ──────
    // FIX 3: The /records/{id}/entries endpoint returns only metadata (list_id,
    // entry_id). We need the full entry to read entry_values and determine whether
    // annual_revenue_aed is already populated before deciding to write it.
    let existingLmRevenue     = false;
    let existingSellerRevenue = false;

    if (existingLmEntryId) {
      const lmDetail = await attio(
        '/v2/lists/' + LEAD_MAGNET_LIST_ID + '/entries/' + existingLmEntryId,
        'GET',
        undefined
      );
      if (lmDetail.ok) {
        const raw = lmDetail.data?.data?.entry_values?.annual_revenue_aed;
        existingLmRevenue = Array.isArray(raw) ? raw.length > 0 : raw != null;
      }
      log.push({ step: 'fetch_lm_entry_detail', entryId: existingLmEntryId, revenueAlreadySet: existingLmRevenue });
    }

    if (existingSellerEntryId) {
      const sellerDetail = await attio(
        '/v2/lists/' + SELLER_DB_LIST_ID + '/entries/' + existingSellerEntryId,
        'GET',
        undefined
      );
      if (sellerDetail.ok) {
        const raw = sellerDetail.data?.data?.entry_values?.estimated_annual_revenue_aed;
        existingSellerRevenue = Array.isArray(raw) ? raw.length > 0 : raw != null;
      }
      log.push({ step: 'fetch_seller_entry_detail', entryId: existingSellerEntryId, revenueAlreadySet: existingSellerRevenue });
    }

    // ── Step 5: Lead Magnet Inbound list -- PATCH if exists, POST if not ───────
    const buildLeadMagnetPayload = (omitRevenue) => {
      const v = {};
      if (contactName)              v.owner_name             = contactName;
      if (contactEmail)             v.owner_email            = contactEmail;
      if (!omitRevenue && revenueAed != null) v.annual_revenue_aed = revenueAed;
      if (ebitdaAed != null)        v.ebitda_estimate_aed_5  = ebitdaAed;
      if (valuationLowAed != null)  v.valuation_low_aed_6    = valuationLowAed;
      if (valuationMidAed != null)  v.valuation_mid_aed      = valuationMidAed;
      if (valuationHighAed != null) v.valuation_high_aed     = valuationHighAed;
      if (maScore != null)          v.m_a_readiness_score    = maScore;
      if (scoreBand)                v.readiness_band         = normaliseBand(scoreBand);
      if (ownerSalaryAed != null)   v.owner_salary           = ownerSalaryAed;
      if (advisoryReferral)         v.recommended_referral   = advisoryReferral;
      if (advisoryNote)             v.internal_advisory_note = advisoryNote;
      return v;
    };

    if (existingLmEntryId) {
      const lmPatch = await attio(
        '/v2/lists/' + LEAD_MAGNET_LIST_ID + '/entries/' + existingLmEntryId,
        'PATCH',
        { data: { entry_values: buildLeadMagnetPayload(existingLmRevenue) } }
      );
      log.push({ step: 'lead_magnet_list', action: 'patch', entryId: existingLmEntryId, omitRevenue: existingLmRevenue, status: lmPatch.status, ok: lmPatch.ok });
    } else {
      const lmPost = await attio(
        '/v2/lists/' + LEAD_MAGNET_LIST_ID + '/entries',
        'POST',
        { data: { parent_record_id: recordId, parent_object: 'companies', entry_values: buildLeadMagnetPayload(false) } }
      );
      const lmOk = lmPost.ok || lmPost.status === 409;
      log.push({ step: 'lead_magnet_list', action: 'post', status: lmPost.status, ok: lmOk });
    }

    // ── Step 6: Seller Database list -- PATCH if exists, POST if not ──────────
    const buildSellerPayload = (omitRevenue) => {
      const v = {};
      if (!omitRevenue && revenueAed != null) v.estimated_annual_revenue_aed = revenueAed;
      if (ebitdaAed != null)  v.estimated_ebitda_aed = ebitdaAed;
      if (contactName)        v.contact_person_owner = contactName;
      if (contactEmail)       v.reach_out_email      = contactEmail;
      return v;
    };

    if (existingSellerEntryId) {
      const sellerPatch = await attio(
        '/v2/lists/' + SELLER_DB_LIST_ID + '/entries/' + existingSellerEntryId,
        'PATCH',
        { data: { entry_values: buildSellerPayload(existingSellerRevenue) } }
      );
      log.push({ step: 'seller_db_list', action: 'patch', entryId: existingSellerEntryId, omitRevenue: existingSellerRevenue, status: sellerPatch.status, ok: sellerPatch.ok });
    } else {
      const sellerPost = await attio(
        '/v2/lists/' + SELLER_DB_LIST_ID + '/entries',
        'POST',
        { data: { parent_record_id: recordId, parent_object: 'companies', entry_values: buildSellerPayload(false) } }
      );
      const sellerOk = sellerPost.ok || sellerPost.status === 409;
      log.push({ step: 'seller_db_list', action: 'post', status: sellerPost.status, ok: sellerOk });
    }

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
