const assert = require('assert').strict;
const path = require('path');
const fs = require('fs');

const config = require('../src/config/config');
const { getDb } = require('../src/db/database');
const { parseAndIngestCSV, normalizeAsset } = require('../src/parser/csvParser');
const { areTypesCompatible, runReconciliation } = require('../src/engine/matchingEngine');
const app = require('../src/app');

// Dynamic Color Logger
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

const stats = {
  passed: 0,
  failed: 0
};

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    stats.passed++;
  } catch (err) {
    console.error(`  ${colors.red}✗${colors.reset} ${name}`);
    console.error(`    ${colors.red}Error: ${err.message}${colors.reset}`);
    if (err.stack) {
      // Print first couple lines of stack
      const lines = err.stack.split('\n').slice(1, 4).join('\n');
      console.error(lines);
    }
    stats.failed++;
  }
}

async function runAllTests() {
  console.log(`${colors.cyan}${colors.bold}========================================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   RUNNING KOINX RECONCILIATION ENGINE TEST SUITE (Zero Dependencies)   ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}========================================================================${colors.reset}\n`);

  const db = getDb();
  
  // ---------------------------------------------------------
  console.log(`${colors.magenta}${colors.bold}1. Core Asset Standardizations & Helper Tests${colors.reset}`);
  // ---------------------------------------------------------
  await test('normalizeAsset() should map aliases case-insensitively', () => {
    assert.equal(normalizeAsset('bitcoin'), 'BTC');
    assert.equal(normalizeAsset('Bitcoin'), 'BTC');
    assert.equal(normalizeAsset('BTC'), 'BTC');
    assert.equal(normalizeAsset('ethereum'), 'ETH');
    assert.equal(normalizeAsset('ether'), 'ETH');
    assert.equal(normalizeAsset('ETH'), 'ETH');
    assert.equal(normalizeAsset('solana'), 'SOL');
    assert.equal(normalizeAsset('Sol'), 'SOL');
    assert.equal(normalizeAsset('polygon'), 'MATIC');
    assert.equal(normalizeAsset('matic'), 'MATIC');
    assert.equal(normalizeAsset('USDT'), 'USDT');
  });

  await test('areTypesCompatible() should accurately map cross-source perspective types', () => {
    assert.equal(areTypesCompatible('BUY', 'BUY'), true);
    assert.equal(areTypesCompatible('SELL', 'SELL'), true);
    assert.equal(areTypesCompatible('TRANSFER_OUT', 'TRANSFER_IN'), true);
    assert.equal(areTypesCompatible('TRANSFER_IN', 'TRANSFER_OUT'), true);
    
    // Incompatible types
    assert.equal(areTypesCompatible('BUY', 'SELL'), false);
    assert.equal(areTypesCompatible('TRANSFER_OUT', 'TRANSFER_OUT'), false);
  });

  // ---------------------------------------------------------
  console.log(`\n${colors.magenta}${colors.bold}2. Ingestion & Data Quality/Validation Tests${colors.reset}`);
  // ---------------------------------------------------------
  await test('parseAndIngestCSV() should process user CSV, validating rows and flagging duplicates/malformations', async () => {
    await db.clearAll();
    const runId = 'test-ingest-run-id';
    
    const summary = await parseAndIngestCSV(config.userCsvPath, 'user', runId);
    
    // Verify count statistics
    assert.equal(summary.total > 0, true);
    assert.equal(summary.valid > 0, true);
    assert.equal(summary.invalid > 0, true);

    const allTx = await db.getTransactions({ importRunId: runId });
    const invalidTx = allTx.filter(t => !t.isValid);

    // Verify USR-018: Malformed timestamp
    const usr018 = allTx.find(t => t.transactionId === 'USR-018');
    assert.ok(usr018);
    assert.equal(usr018.isValid, false);
    assert.ok(usr018.validationError.includes('Malformed timestamp'));

    // Verify USR-019: Negative quantity
    const usr019 = allTx.find(t => t.transactionId === 'USR-019');
    assert.ok(usr019);
    assert.equal(usr019.isValid, false);
    assert.ok(usr019.validationError.includes('must be positive'));

    // Verify USR-001: Internal duplicates in CSV
    const usr001s = allTx.filter(t => t.transactionId === 'USR-001');
    assert.equal(usr001s.length, 2);
    assert.equal(usr001s[0].isValid, false);
    assert.ok(usr001s[0].validationError.includes('Duplicate transaction ID'));
  });

  // ---------------------------------------------------------
  console.log(`\n${colors.magenta}${colors.bold}3. Matching Engine & Reconciliation Logic Tests${colors.reset}`);
  // ---------------------------------------------------------
  await test('runReconciliation() should compute correct categories under default tolerances', async () => {
    await db.clearAll();
    const runId = 'test-reconciliation-run-1';

    // Ingest both datasets
    await parseAndIngestCSV(config.userCsvPath, 'user', runId);
    await parseAndIngestCSV(config.exchangeCsvPath, 'exchange', runId);

    // Trigger reconciliation run
    const runRecord = await runReconciliation(runId, {
      timestampToleranceSeconds: 300,
      quantityTolerancePct: 0.01
    });

    assert.equal(runRecord.runId, runId);
    assert.equal(runRecord.summary.matched > 0, true);
    assert.equal(runRecord.summary.conflicting > 0, true);
    assert.equal(runRecord.summary.unmatchedUser, 0);
    assert.equal(runRecord.summary.unmatchedExchange > 0, true);

    const reportEntries = await db.getReportEntries({ runId });

    // Verify type mapping transfer_out to transfer_in matched
    const transferEntry = reportEntries.find(e => 
      e.category === 'matched' && 
      e.userTransaction && e.userTransaction.transactionId === 'USR-004'
    );
    assert.ok(transferEntry);
    assert.equal(transferEntry.exchangeTransaction.transactionId, 'EXC-1004');

    // Verify conflict entry: EXC-1012 has quantity 0.3001, USR-012 has 0.3
    // Difference is (0.0001 / 0.3) * 100 = 0.0333%, exceeding default tolerance 0.01%
    const conflictEntry = reportEntries.find(e => 
      e.userTransaction && e.userTransaction.transactionId === 'USR-012'
    );
    assert.ok(conflictEntry);
    assert.equal(conflictEntry.category, 'conflicting');
    assert.ok(conflictEntry.reason.includes('Quantity diff'));
  });

  await test('runReconciliation() should match near-misses when tolerances are widened', async () => {
    await db.clearAll();
    const runId = 'test-reconciliation-run-2';

    // Ingest datasets
    await parseAndIngestCSV(config.userCsvPath, 'user', runId);
    await parseAndIngestCSV(config.exchangeCsvPath, 'exchange', runId);

    // Wider tolerances (Quantity: 0.05% > 0.0333%)
    const runRecord = await runReconciliation(runId, {
      timestampToleranceSeconds: 300,
      quantityTolerancePct: 0.05
    });

    const reportEntries = await db.getReportEntries({ runId });

    // Verify USR-012 is now MATCHED
    const matchedEntry = reportEntries.find(e => 
      e.userTransaction && e.userTransaction.transactionId === 'USR-012'
    );
    assert.ok(matchedEntry);
    assert.equal(matchedEntry.category, 'matched');
    assert.equal(matchedEntry.exchangeTransaction.transactionId, 'EXC-1012');
  });

  // ---------------------------------------------------------
  console.log(`\n${colors.magenta}${colors.bold}4. REST API Endpoint Integration Tests${colors.reset}`);
  // ---------------------------------------------------------
  await test('POST /reconcile should trigger reconciliation and return 201 with summary', async () => {
    await db.clearAll();
    
    const response = await app.dispatch({
      method: 'POST',
      url: '/reconcile',
      body: {
        timestampToleranceSeconds: 300,
        quantityTolerancePct: 0.01
      }
    });

    assert.equal(response.statusCode, 201);
    assert.ok(response.body.runId);
    assert.ok(response.body.summary);
    
    // Save run ID for subsequent tests
    const runId = response.body.runId;

    // Test GET /report/:runId/summary
    const summaryResponse = await app.dispatch({
      method: 'GET',
      url: `/report/${runId}/summary`
    });
    assert.equal(summaryResponse.statusCode, 200);
    assert.equal(summaryResponse.body.runId, runId);
    assert.equal(summaryResponse.body.summary.matched > 0, true);

    // Test GET /report/:runId/unmatched
    const unmatchedResponse = await app.dispatch({
      method: 'GET',
      url: `/report/${runId}/unmatched`
    });
    assert.equal(unmatchedResponse.statusCode, 200);
    assert.equal(unmatchedResponse.body.runId, runId);
    assert.equal(unmatchedResponse.body.unmatchedUser.length, 0);
    assert.ok(unmatchedResponse.body.unmatchedExchange.length > 0);

    // Test GET /report/:runId CSV stream
    const reportResponse = await app.dispatch({
      method: 'GET',
      url: `/report/${runId}`
    });
    assert.equal(reportResponse.statusCode, 200);
    assert.equal(reportResponse.headers['Content-Type'], 'text/csv');
    assert.ok(reportResponse.body.includes('category,reason,user_transaction_id'));
    assert.ok(reportResponse.body.includes('matched'));
    assert.ok(reportResponse.body.includes('conflicting'));
  });

  await test('GET /report/:runId should return 404 for invalid run ID', async () => {
    const response = await app.dispatch({
      method: 'GET',
      url: '/report/non-existent-run-id'
    });
    assert.equal(response.statusCode, 404);
    assert.ok(response.body.error);
  });

  // ---------------------------------------------------------
  console.log(`\n${colors.cyan}${colors.bold}========================================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}                           TEST RESULTS SUMMARY                         ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}========================================================================${colors.reset}`);
  console.log(`  Total Passed: ${colors.green}${stats.passed}${colors.reset}`);
  console.log(`  Total Failed: ${stats.failed > 0 ? colors.red : colors.green}${stats.failed}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}========================================================================${colors.reset}\n`);

  if (stats.failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Execute tests
runAllTests().catch(err => {
  console.error('Test suite runner crashed:', err);
  process.exit(1);
});
