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

/**
 * Serve a beautiful welcome landing page for the root endpoint (GET /)
 */
function getRoot(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KoinX Reconciliation Engine | Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090b11;
      --card: #131722;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: #374151;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
      background-image: radial-gradient(circle at 10% 20%, rgba(79, 70, 229, 0.1) 0%, transparent 40%),
                        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.05) 0%, transparent 40%);
    }

    .container {
      max-width: 800px;
      width: 100%;
      background: rgba(19, 23, 34, 0.7);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 3rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    .badge {
      display: inline-block;
      padding: 0.35rem 1rem;
      background: rgba(79, 70, 229, 0.15);
      color: #818cf8;
      border: 1px solid rgba(79, 70, 229, 0.3);
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
      text-transform: uppercase;
    }

    h1 {
      font-size: 2.25rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #ffffff, #9ca3af);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    p.lead {
      color: var(--text-muted);
      font-size: 1.1rem;
      line-height: 1.6;
      max-width: 600px;
      margin: 0 auto;
    }

    .btn-container {
      display: flex;
      justify-content: center;
      margin-bottom: 3rem;
    }

    .btn {
      font-family: inherit;
      background-color: var(--primary);
      color: #ffffff;
      font-weight: 700;
      font-size: 1rem;
      padding: 1rem 2.5rem;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 10px 15px -3px rgba(79, 70, 229, 0.4);
    }

    .btn:hover {
      background-color: var(--primary-hover);
      transform: translateY(-2px);
      box-shadow: 0 20px 25px -5px rgba(79, 70, 229, 0.4);
    }

    .btn:active {
      transform: translateY(0);
    }

    .endpoints {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 2rem;
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
      color: #ffffff;
    }

    .endpoint-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 0.2s ease;
    }

    .endpoint-card:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .method {
      font-size: 0.8rem;
      font-weight: 800;
      padding: 0.25rem 0.65rem;
      border-radius: 6px;
      text-transform: uppercase;
      margin-right: 1rem;
      min-width: 65px;
      text-align: center;
      display: inline-block;
    }

    .method.post {
      background: rgba(79, 70, 229, 0.15);
      color: #818cf8;
      border: 1px solid rgba(79, 70, 229, 0.3);
    }

    .method.get {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .route-info {
      display: flex;
      align-items: center;
    }

    .route-path {
      font-family: monospace;
      font-size: 0.95rem;
      font-weight: 600;
      color: #ffffff;
    }

    .desc {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: 0.25rem;
    }

    .action-link {
      color: #818cf8;
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      transition: color 0.15s ease;
    }

    .action-link:hover {
      color: #a5b4fc;
      text-decoration: underline;
    }

    footer {
      text-align: center;
      margin-top: 3rem;
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    footer a {
      color: #818cf8;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <span class="badge">KoinX Take-Home Assignment</span>
      <h1>Reconciliation Engine Dashboard</h1>
      <p class="lead">An institutional-grade, multi-phase matching and reconciliation API designed for crypto transaction histories.</p>
    </header>

    <div class="btn-container">
      <button class="btn" onclick="window.location.href='/reconcile'">🚀 Run Reconciliation Engine</button>
    </div>

    <div class="endpoints">
      <h2>Interactive REST Endpoints</h2>
      
      <div class="endpoint-card">
        <div>
          <div class="route-info">
            <span class="method get">GET</span>
            <span class="route-path">/reconcile</span>
          </div>
          <div class="desc">Triggers/runs matching engine & saves report to database. (Click below to test instantly!)</div>
        </div>
        <a class="action-link" href="/reconcile">Run now &rarr;</a>
      </div>

      <div class="endpoint-card">
        <div>
          <div class="route-info">
            <span class="method get">GET</span>
            <span class="route-path">/report/:runId</span>
          </div>
          <div class="desc">Streams downloadable CSV report mapping categories & details.</div>
        </div>
        <span class="desc">CSV Download</span>
      </div>

      <div class="endpoint-card">
        <div>
          <div class="route-info">
            <span class="method get">GET</span>
            <span class="route-path">/report/:runId/summary</span>
          </div>
          <div class="desc">Fetches JSON containing counts (matched, conflicting, unmatched).</div>
        </div>
        <span class="desc">JSON Summary</span>
      </div>

      <div class="endpoint-card">
        <div>
          <div class="route-info">
            <span class="method get">GET</span>
            <span class="route-path">/report/:runId/unmatched</span>
          </div>
          <div class="desc">Retrieves detailed JSON of all unmatched transactions with reasons.</div>
        </div>
        <span class="desc">JSON List</span>
      </div>
    </div>

    <footer>
      Submitted by <a href="mailto:kushagra.jaiswal@koinx.com">Kushagra Jaiswal</a> &copy; 2026. Made with ❤️ for the KoinX team.
    </footer>
  </div>
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
