const { randomUUID: uuidv4 } = require('crypto');
const config = require('../config/config');
const { getDb } = require('../db/database');
const { parseAndIngestCSV } = require('../parser/csvParser');
const { runReconciliation } = require('../engine/matchingEngine');

/**
 * Helper to escape CSV fields
 */
function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Trigger a new reconciliation run
 */
async function reconcile(req, res) {
  try {
    const db = getDb();
    const runId = uuidv4();

    // Tolerances: request body overrides > env variables > defaults
    const timestampToleranceSeconds = req.body && req.body.timestampToleranceSeconds !== undefined 
      ? parseInt(req.body.timestampToleranceSeconds, 10) 
      : config.timestampToleranceSeconds;

    const quantityTolerancePct = req.body && req.body.quantityTolerancePct !== undefined 
      ? parseFloat(req.body.quantityTolerancePct) 
      : config.quantityTolerancePct;

    if (isNaN(timestampToleranceSeconds) || timestampToleranceSeconds < 0) {
      return res.status(400).json({ error: 'Invalid timestampToleranceSeconds' });
    }
    if (isNaN(quantityTolerancePct) || quantityTolerancePct < 0) {
      return res.status(400).json({ error: 'Invalid quantityTolerancePct' });
    }

    // Connect to database if not already
    await db.connect();

    // 1. Ingest User Transactions CSV
    const userIngest = await parseAndIngestCSV(
      config.userCsvPath,
      'user',
      runId
    );

    // 2. Ingest Exchange Transactions CSV
    const exchangeIngest = await parseAndIngestCSV(
      config.exchangeCsvPath,
      'exchange',
      runId
    );

    // 3. Run Matching Engine
    const runRecord = await runReconciliation(runId, {
      timestampToleranceSeconds,
      quantityTolerancePct
    });

    res.status(201).json(runRecord);
  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ error: 'Failed to execute reconciliation: ' + error.message });
  }
}

/**
 * Fetch full reconciliation report for a run (CSV format)
 */
async function getReport(req, res) {
  try {
    const { runId } = req.params;
    const db = getDb();

    await db.connect();

    const run = await db.getReconciliationRun(runId);
    if (!run) {
      return res.status(404).json({ error: `Reconciliation run '${runId}' not found` });
    }

    const entries = await db.getReportEntries({ runId });

    // Generate CSV Header
    const csvHeaders = [
      'category',
      'reason',
      'user_transaction_id',
      'user_timestamp',
      'user_type',
      'user_asset',
      'user_quantity',
      'user_price_usd',
      'user_fee',
      'user_note',
      'exchange_transaction_id',
      'exchange_timestamp',
      'exchange_type',
      'exchange_asset',
      'exchange_quantity',
      'exchange_price_usd',
      'exchange_fee',
      'exchange_note'
    ];

    const csvRows = [csvHeaders.join(',')];

    for (const entry of entries) {
      const u = entry.userTransaction || {};
      const e = entry.exchangeTransaction || {};

      const row = [
        entry.category,
        entry.reason,
        u.transactionId || '',
        u.timestamp ? new Date(u.timestamp).toISOString() : (u.rawTimestamp || ''),
        u.type || '',
        u.asset || (u.rawAsset || ''),
        u.quantity !== undefined ? u.quantity : (u.rawQuantity || ''),
        u.priceUsd || '',
        u.fee || '',
        u.note || '',
        e.transactionId || '',
        e.timestamp ? new Date(e.timestamp).toISOString() : (e.rawTimestamp || ''),
        e.type || '',
        e.asset || (e.rawAsset || ''),
        e.quantity !== undefined ? e.quantity : (e.rawQuantity || ''),
        e.priceUsd || '',
        e.fee || '',
        e.note || ''
      ];

      csvRows.push(row.map(escapeCsvField).join(','));
    }

    const csvContent = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=reconciliation_report_${runId}.csv`);
    res.status(200).send(csvContent);
  } catch (error) {
    console.error('Failed to generate CSV report:', error);
    res.status(500).json({ error: 'Failed to retrieve report: ' + error.message });
  }
}

/**
 * Fetch reconciliation summary counts for a run
 */
async function getSummary(req, res) {
  try {
    const { runId } = req.params;
    const db = getDb();

    await db.connect();

    const run = await db.getReconciliationRun(runId);
    if (!run) {
      return res.status(404).json({ error: `Reconciliation run '${runId}' not found` });
    }

    res.status(200).json({
      runId: run.runId,
      timestamp: run.timestamp,
      config: run.config,
      summary: run.summary
    });
  } catch (error) {
    console.error('Failed to fetch summary:', error);
    res.status(500).json({ error: 'Failed to retrieve summary: ' + error.message });
  }
}

/**
 * Fetch only unmatched rows for a run with reasons
 */
async function getUnmatched(req, res) {
  try {
    const { runId } = req.params;
    const db = getDb();

    await db.connect();

    const run = await db.getReconciliationRun(runId);
    if (!run) {
      return res.status(404).json({ error: `Reconciliation run '${runId}' not found` });
    }

    const entries = await db.getReportEntries({ runId });

    const unmatchedUser = entries
      .filter(e => e.category === 'unmatched_user')
      .map(e => ({
        transaction: e.userTransaction,
        reason: e.reason
      }));

    const unmatchedExchange = entries
      .filter(e => e.category === 'unmatched_exchange')
      .map(e => ({
        transaction: e.exchangeTransaction,
        reason: e.reason
      }));

    res.status(200).json({
      runId,
      unmatchedCount: unmatchedUser.length + unmatchedExchange.length,
      unmatchedUser,
      unmatchedExchange
    });
  } catch (error) {
    console.error('Failed to fetch unmatched:', error);
    res.status(500).json({ error: 'Failed to retrieve unmatched: ' + error.message });
  }
}

function getRoot(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reconciliation Engine — KoinX</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', sans-serif;
      background: #0a0a0a;
      color: #e2e2e2;
      min-height: 100vh;
      padding: 3rem 1rem;
    }

    .page {
      max-width: 720px;
      margin: 0 auto;
    }

    /* Header */
    .header { margin-bottom: 3rem; }
    .header-tag {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #555;
      margin-bottom: 0.75rem;
    }
    .header h1 {
      font-size: 1.6rem;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .header p {
      font-size: 0.9rem;
      color: #666;
      line-height: 1.6;
    }

    /* Run section */
    .run-section {
      border: 1px solid #1e1e1e;
      border-radius: 10px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      background: #111;
    }
    .run-section h2 {
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #555;
      margin-bottom: 1.25rem;
    }
    .run-btn {
      font-family: 'Inter', sans-serif;
      font-size: 0.875rem;
      font-weight: 600;
      background: #fff;
      color: #0a0a0a;
      border: none;
      border-radius: 7px;
      padding: 0.65rem 1.5rem;
      cursor: pointer;
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    .run-btn:hover { background: #e2e2e2; }
    .run-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .status-bar {
      margin-top: 1rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: #555;
      min-height: 1.2rem;
    }
    .status-bar.ok { color: #4ade80; }
    .status-bar.err { color: #f87171; }
    .status-bar.loading { color: #888; }

    /* Result box */
    .result-box {
      margin-top: 1.25rem;
      background: #0d0d0d;
      border: 1px solid #1e1e1e;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      display: none;
    }
    .result-box.show { display: block; }
    .result-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1rem;
    }
    .stat { }
    .stat-label {
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #444;
      margin-bottom: 0.2rem;
    }
    .stat-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.25rem;
      font-weight: 500;
      color: #fff;
    }
    .run-id-row {
      border-top: 1px solid #1e1e1e;
      padding-top: 0.75rem;
      font-size: 0.75rem;
      color: #444;
    }
    .run-id-val {
      font-family: 'JetBrains Mono', monospace;
      color: #666;
      word-break: break-all;
    }

    /* Endpoints */
    .endpoints-section h2 {
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #555;
      margin-bottom: 1rem;
    }

    .endpoint-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border: 1px solid #1e1e1e;
      border-radius: 8px;
      margin-bottom: 0.5rem;
      background: #111;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s ease, background 0.15s ease;
      cursor: default;
      opacity: 0.4;
    }
    .endpoint-row.active {
      cursor: pointer;
      opacity: 1;
    }
    .endpoint-row.active:hover {
      border-color: #333;
      background: #161616;
    }
    .ep-left { display: flex; align-items: center; gap: 0.75rem; }
    .method-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      color: #888;
      letter-spacing: 0.05em;
    }
    .ep-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      color: #ccc;
    }
    .ep-desc {
      font-size: 0.78rem;
      color: #444;
      margin-top: 0.15rem;
    }
    .ep-action {
      font-size: 0.78rem;
      font-weight: 500;
      color: #333;
      white-space: nowrap;
    }
    .endpoint-row.active .ep-action { color: #666; }

    /* Divider */
    hr {
      border: none;
      border-top: 1px solid #1a1a1a;
      margin: 2rem 0;
    }

    /* Footer */
    footer {
      font-size: 0.75rem;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="page">

    <div class="header">
      <p class="header-tag">KoinX · Backend Assignment</p>
      <h1>Transaction Reconciliation Engine</h1>
      <p>Matches crypto transaction records from two sources, flags data quality issues, and generates a full reconciliation report.</p>
    </div>

    <!-- Run Section -->
    <div class="run-section">
      <h2>Step 1 — Run Engine</h2>
      <button class="run-btn" id="runBtn" onclick="runReconciliation()">Run Reconciliation</button>
      <div class="status-bar" id="statusBar"></div>

      <div class="result-box" id="resultBox">
        <div class="result-grid">
          <div class="stat">
            <div class="stat-label">Matched</div>
            <div class="stat-val" id="statMatched">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">Conflicting</div>
            <div class="stat-val" id="statConflicting">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">Unmatched (Exch.)</div>
            <div class="stat-val" id="statUnmatched">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">Invalid (User)</div>
            <div class="stat-val" id="statInvalid">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">Timestamp Tol.</div>
            <div class="stat-val" id="statTs">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">Qty Tolerance</div>
            <div class="stat-val" id="statQty">—</div>
          </div>
        </div>
        <div class="run-id-row">
          Run ID: <span class="run-id-val" id="runIdDisplay">—</span>
        </div>
      </div>
    </div>

    <!-- Endpoints Section -->
    <div class="endpoints-section">
      <h2>Step 2 — Explore Results</h2>

      <a class="endpoint-row" id="epReport" href="#" target="_blank">
        <div class="ep-left">
          <span class="method-tag">GET</span>
          <div>
            <div class="ep-path">/report/:runId</div>
            <div class="ep-desc">Download full reconciliation report as CSV</div>
          </div>
        </div>
        <span class="ep-action">↓ CSV</span>
      </a>

      <a class="endpoint-row" id="epSummary" href="#" target="_blank">
        <div class="ep-left">
          <span class="method-tag">GET</span>
          <div>
            <div class="ep-path">/report/:runId/summary</div>
            <div class="ep-desc">Fetch summary counts as JSON</div>
          </div>
        </div>
        <span class="ep-action">→ JSON</span>
      </a>

      <a class="endpoint-row" id="epUnmatched" href="#" target="_blank">
        <div class="ep-left">
          <span class="method-tag">GET</span>
          <div>
            <div class="ep-path">/report/:runId/unmatched</div>
            <div class="ep-desc">Fetch unmatched transactions with reasons as JSON</div>
          </div>
        </div>
        <span class="ep-action">→ JSON</span>
      </a>
    </div>

    <hr>
    <footer>Submitted by Kushagra Jaiswal &middot; KoinX Backend Intern Assignment 2026</footer>
  </div>

  <script>
    async function runReconciliation() {
      const btn = document.getElementById('runBtn');
      const status = document.getElementById('statusBar');
      const resultBox = document.getElementById('resultBox');

      btn.disabled = true;
      status.className = 'status-bar loading';
      status.textContent = 'Running engine...';

      try {
        const res = await fetch('/reconcile');
        const data = await res.json();

        if (!res.ok || !data.runId) throw new Error(data.error || 'Unexpected response');

        const runId = data.runId;
        const s = data.summary;
        const c = data.config;

        // Populate stats
        document.getElementById('statMatched').textContent = s.matched;
        document.getElementById('statConflicting').textContent = s.conflicting;
        document.getElementById('statUnmatched').textContent = s.unmatchedExchange + s.unmatchedUser;
        document.getElementById('statInvalid').textContent = s.invalidUserRows;
        document.getElementById('statTs').textContent = c.timestampToleranceSeconds + 's';
        document.getElementById('statQty').textContent = c.quantityTolerancePct + '%';
        document.getElementById('runIdDisplay').textContent = runId;

        // Show result box
        resultBox.classList.add('show');

        // Enable and populate other endpoint links
        const epReport = document.getElementById('epReport');
        const epSummary = document.getElementById('epSummary');
        const epUnmatched = document.getElementById('epUnmatched');

        epReport.href = '/report/' + runId;
        epSummary.href = '/report/' + runId + '/summary';
        epUnmatched.href = '/report/' + runId + '/unmatched';

        epReport.classList.add('active');
        epSummary.classList.add('active');
        epUnmatched.classList.add('active');

        status.className = 'status-bar ok';
        status.textContent = 'Done. Run ID: ' + runId;

        btn.textContent = 'Run Again';
        btn.disabled = false;

      } catch (err) {
        status.className = 'status-bar err';
        status.textContent = 'Error: ' + err.message;
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}
module.exports = {
  reconcile,
  getReport,
  getSummary,
  getUnmatched,
  getRoot
};
