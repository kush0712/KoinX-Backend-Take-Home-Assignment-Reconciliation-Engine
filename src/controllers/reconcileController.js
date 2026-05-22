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

module.exports = {
  reconcile,
  getReport,
  getSummary,
  getUnmatched
};
