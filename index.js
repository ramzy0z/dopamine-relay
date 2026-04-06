const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── CORS ────────────────────────────────────────────────────────────────────
// After deploying HTML tools to Vercel, set ALLOWED_ORIGIN env var on Render:
//   ALLOWED_ORIGIN=https://your-project.vercel.app
// Until then '*' allows testing from any origin.
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

// ─── STRUCTURED LEAD SUBMISSION ───────────────────────────────────────────────
// Single endpoint that writes to three Attio targets on every submission:
//   1. Upsert Companies record  (domain is the dedup key)
//   2. Add to Lead Magnet Inbound list
//   3. Add to Seller Database list
//
// All USD financials are converted to AED at the fixed peg of 3.6725.
//
// Request body:
// {
//   companyName:     string,
//   domain:          string   -- REQUIRED
//   description:     string,
//   sector:          string,
//   geo:             string,
//   contactName:     string,
//   contactEmail:    string,
//   revenueUsd:      number,
//   ebitdaUsd:       number,  -- optional
//   leadSource:      string,  -- 'Valuation Tool' | 'M&A Readiness Tool'
//   maScore:         number,  -- Readiness Tool only (0-100)
//   scoreBand:       string,  -- Readiness Tool only
//   valuationLowUsd: number,  -- Valuation Tool only
//   valuationMidUsd: number,  -- Valuation Tool only
//   valuationHighUsd:number   -- Valuation Tool only
// }

const AED_PEG = 3.6725;
const toAed = (usd) => (usd != null && !isNaN(usd)) ? Math.round(Number(usd) * AED_PEG) : null;

const LEAD_MAGNET_LIST_ID = '60ffc158-8444-4d29-b072-e6ed0c374596';
const SELLER_DB_LIST_ID   = '6c2ea989-a5d7-4257-8d7c-f58268718de9';

app.post('/submit-lead', async (req, res) => {
  const ATTIO_KEY = process.env.ATTIO_KEY;
  if (!ATTIO_KEY) return res.status(500).json({ error: 'ATTIO_KEY not set' });

  const {
    companyName, domain, description, sector, geo,
    contactName, contactEmail,
    revenueUsd, ebitdaUsd,
    leadSource,
    maScore, scoreBand,
    valuationLowUsd, valuationMidUsd, valuationHighUsd
  } = req.body;

  if (!domain || !domain.trim()) {
    return res.status(400).json({ error: 'domain is required for company deduplication' });
  }

  const revenueAed       = toAed(revenueUsd);
  const ebitdaAed        = toAed(ebitdaUsd);
  const valuationLowAed  = toAed(valuationLowUsd);
  const valuationMidAed  = toAed(valuationMidUsd);
  const valuationHighAed = toAed(valuationHighUsd);

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
    // NOTE: entry_values will be populated with field slugs once 3.3 fields
    // are created in Attio. Currently only system fields exist on this list.
    const leadMagnetEntryValues = {};

    const lmEntry = await attio(
      '/v2/lists/' + LEAD_MAGNET_LIST_ID + '/entries',
      'POST',
      { data: { parent_record_id: recordId, parent_object: 'companies', entry_values: leadMagnetEntryValues } }
    );
    // 409 = record already on list, treat as success
    const lmOk = lmEntry.ok || lmEntry.status === 409;
    log.push({ step: 'lead_magnet_list', status: lmEntry.status, ok: lmOk });

    // Step 3: Add to Seller Database list
    const sellerEntryValues = {};
    if (revenueAed != null)  sellerEntryValues.estimated_annual_revenue_aed = revenueAed;
    if (ebitdaAed != null)   sellerEntryValues.estimated_ebitda_aed          = ebitdaAed;
    if (contactName)         sellerEntryValues.contact_person_owner          = contactName;
    if (contactEmail)        sellerEntryValues.reach_out_email               = contactEmail;

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
      log
    });

  } catch (e) {
    res.status(500).json({ error: e.message, log });
  }
});

// ─── SERVER ──────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => console.log('Dopamine relay running'));
