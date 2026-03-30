const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

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

app.listen(process.env.PORT || 3000, () => console.log('Dopamine relay running'));
