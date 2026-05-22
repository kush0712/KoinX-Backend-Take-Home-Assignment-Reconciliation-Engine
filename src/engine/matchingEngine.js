const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Checks if a user transaction type matches an exchange transaction type
 */
function areTypesCompatible(userType, exchangeType) {
  if (userType === 'BUY' && exchangeType === 'BUY') return true;
  if (userType === 'SELL' && exchangeType === 'SELL') return true;
  if (userType === 'TRANSFER_OUT' && exchangeType === 'TRANSFER_IN') return true;
  if (userType === 'TRANSFER_IN' && exchangeType === 'TRANSFER_OUT') return true;
  return false;
}

/**
 * Executes the reconciliation matching algorithm
 * 
 * @param {string} importRunId - UUID of the current reconciliation run
 * @param {object} options - Tolerances and config
 * @param {number} options.timestampToleranceSeconds - Timestamp tolerance window
 * @param {number} options.quantityTolerancePct - Quantity tolerance percentage
 * @returns {Promise<object>} Summary of the reconciliation run
 */
async function runReconciliation(importRunId, options) {
  const db = getDb();
  
  const { timestampToleranceSeconds, quantityTolerancePct } = options;

  // Retrieve valid transactions for this run
  const userTransactions = await db.getTransactions({
    importRunId,
    source: 'user',
    isValid: true
  });
  
  const exchangeTransactions = await db.getTransactions({
    importRunId,
    source: 'exchange',
    isValid: true
  });

  // Retrieve invalid transactions counts for summary
  const invalidUserTx = await db.getTransactions({
    importRunId,
    source: 'user',
    isValid: false
  });

  const invalidExchangeTx = await db.getTransactions({
    importRunId,
    source: 'exchange',
    isValid: false
  });

  // Track matched transaction IDs
  const matchedUserIds = new Set();
  const matchedExchangeIds = new Set();
  const reportEntries = [];

  // Sort by timestamp to ensure deterministic, chronological matching
  userTransactions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  exchangeTransactions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // --- PHASE 1: STRICT MATCHING ---
  for (const userTx of userTransactions) {
    let bestMatch = null;
    let minTimeDiff = Infinity;

    for (const exchangeTx of exchangeTransactions) {
      // Skip already matched exchange transactions
      if (matchedExchangeIds.has(exchangeTx.transactionId)) continue;

      // Rule 1: Asset must match (case-insensitive done in parser)
      if (userTx.asset !== exchangeTx.asset) continue;

      // Rule 2: Types must be compatible
      if (!areTypesCompatible(userTx.type, exchangeTx.type)) continue;

      // Rule 3: Timestamp within tolerance
      const timeDiff = Math.abs(userTx.timestamp.getTime() - exchangeTx.timestamp.getTime()) / 1000;
      if (timeDiff > timestampToleranceSeconds) continue;

      // Rule 4: Quantity within tolerance
      const quantityDiffPct = (Math.abs(userTx.quantity - exchangeTx.quantity) / userTx.quantity) * 100;
      if (quantityDiffPct > quantityTolerancePct) continue;

      // Find closest timestamp match if multiple candidates exist
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        bestMatch = exchangeTx;
      }
    }

    if (bestMatch) {
      matchedUserIds.add(userTx.transactionId);
      matchedExchangeIds.add(bestMatch.transactionId);

      const timeDiff = Math.abs(userTx.timestamp.getTime() - bestMatch.timestamp.getTime()) / 1000;
      const quantityDiffPct = (Math.abs(userTx.quantity - bestMatch.quantity) / userTx.quantity) * 100;

      reportEntries.push({
        entryId: uuidv4(),
        runId: importRunId,
        category: 'matched',
        reason: `Matched within tolerances (Timestamp diff: ${timeDiff.toFixed(2)}s, Quantity diff: ${quantityDiffPct.toFixed(4)}%)`,
        userTransaction: userTx,
        exchangeTransaction: bestMatch
      });
    }
  }

  // --- PHASE 2: CONFLICT DETECTION (PROXIMITY MATCHES BEYOND TOLERANCE) ---
  // Broader window for detecting human or export errors (e.g. 24 hours)
  const CONFLICT_WINDOW_SECONDS = 24 * 60 * 60; // 24 hours

  for (const userTx of userTransactions) {
    if (matchedUserIds.has(userTx.transactionId)) continue;

    let bestConflictCandidate = null;
    let minTimeDiff = Infinity;

    for (const exchangeTx of exchangeTransactions) {
      if (matchedExchangeIds.has(exchangeTx.transactionId)) continue;

      // Compatible asset and type
      if (userTx.asset !== exchangeTx.asset) continue;
      if (!areTypesCompatible(userTx.type, exchangeTx.type)) continue;

      // Check proximity (within 24 hours)
      const timeDiff = Math.abs(userTx.timestamp.getTime() - exchangeTx.timestamp.getTime()) / 1000;
      if (timeDiff > CONFLICT_WINDOW_SECONDS) continue;

      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        bestConflictCandidate = exchangeTx;
      }
    }

    if (bestConflictCandidate) {
      matchedUserIds.add(userTx.transactionId);
      matchedExchangeIds.add(bestConflictCandidate.transactionId);

      const timeDiff = Math.abs(userTx.timestamp.getTime() - bestConflictCandidate.timestamp.getTime()) / 1000;
      const quantityDiffPct = (Math.abs(userTx.quantity - bestConflictCandidate.quantity) / userTx.quantity) * 100;

      const mismatchReasons = [];
      if (timeDiff > timestampToleranceSeconds) {
        mismatchReasons.push(`Timestamp diff of ${timeDiff.toFixed(1)}s exceeds tolerance of ${timestampToleranceSeconds}s`);
      }
      if (quantityDiffPct > quantityTolerancePct) {
        mismatchReasons.push(`Quantity diff of ${quantityDiffPct.toFixed(4)}% exceeds tolerance of ${quantityTolerancePct}% (User: ${userTx.quantity}, Exchange: ${bestConflictCandidate.quantity})`);
      }

      reportEntries.push({
        entryId: uuidv4(),
        runId: importRunId,
        category: 'conflicting',
        reason: `Conflict: ${mismatchReasons.join(' & ')}`,
        userTransaction: userTx,
        exchangeTransaction: bestConflictCandidate
      });
    }
  }

  // --- PHASE 3: UNMATCHED USER TRANSACTIONS ---
  for (const userTx of userTransactions) {
    if (matchedUserIds.has(userTx.transactionId)) continue;

    reportEntries.push({
      entryId: uuidv4(),
      runId: importRunId,
      category: 'unmatched_user',
      reason: 'No matching transaction found in exchange records for the same asset, type, and timeframe',
      userTransaction: userTx,
      exchangeTransaction: null
    });
  }

  // --- PHASE 4: UNMATCHED EXCHANGE TRANSACTIONS ---
  for (const exchangeTx of exchangeTransactions) {
    if (matchedExchangeIds.has(exchangeTx.transactionId)) continue;

    reportEntries.push({
      entryId: uuidv4(),
      runId: importRunId,
      category: 'unmatched_exchange',
      reason: 'No matching transaction found in user records for the same asset, type, and timeframe',
      userTransaction: null,
      exchangeTransaction: exchangeTx
    });
  }

  // Save report entries to the database
  if (reportEntries.length > 0) {
    await db.saveReportEntries(reportEntries);
  }

  // Compile summary
  const summary = {
    matched: reportEntries.filter(e => e.category === 'matched').length,
    conflicting: reportEntries.filter(e => e.category === 'conflicting').length,
    unmatchedUser: reportEntries.filter(e => e.category === 'unmatched_user').length,
    unmatchedExchange: reportEntries.filter(e => e.category === 'unmatched_exchange').length,
    invalidUserRows: invalidUserTx.length,
    invalidExchangeRows: invalidExchangeTx.length
  };

  // Create and save run summary
  const runRecord = {
    runId: importRunId,
    timestamp: new Date(),
    config: {
      timestampToleranceSeconds,
      quantityTolerancePct
    },
    summary
  };
  
  await db.saveReconciliationRun(runRecord);

  return runRecord;
}

module.exports = {
  runReconciliation,
  areTypesCompatible
};
