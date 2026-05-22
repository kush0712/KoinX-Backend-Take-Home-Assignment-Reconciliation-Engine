const fs = require('fs');
const { getDb } = require('../db/database');

// Asset alias mappings
const ASSET_ALIASES = {
  'BITCOIN': 'BTC',
  'ETHER': 'ETH',
  'ETHEREUM': 'ETH',
  'SOLANA': 'SOL',
  'POLYGON': 'MATIC',
  'MATIC': 'MATIC',
  'CHAINLINK': 'LINK',
  'LINK': 'LINK',
  'TETHER': 'USDT',
  'USDT': 'USDT'
};

/**
 * Custom robust CSV line parser that respects double quotes and commas within quotes
 */
function parseCSVLine(line) {
  const fields = [];
  let currentField = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  fields.push(currentField.trim());
  return fields;
}

/**
 * Resolves standard symbol for an asset, mapping common aliases
 */
function normalizeAsset(asset) {
  if (!asset) return '';
  const clean = asset.trim().toUpperCase();
  return ASSET_ALIASES[clean] || clean;
}

/**
 * Parses and ingests a CSV transaction file into the database
 * 
 * @param {string} filePath - Absolute path to the CSV file
 * @param {string} source - 'user' or 'exchange'
 * @param {string} importRunId - UUID of the current reconciliation run
 * @returns {Promise<{total: number, valid: number, invalid: number}>}
 */
async function parseAndIngestCSV(filePath, source, importRunId) {
  const db = getDb();
  
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV File not found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  
  if (lines.length === 0) {
    return { total: 0, valid: 0, invalid: 0 };
  }

  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine).map(h => h.toLowerCase());
  
  const txIdIndex = headers.indexOf('transaction_id');
  const timestampIndex = headers.indexOf('timestamp');
  const typeIndex = headers.indexOf('type');
  const assetIndex = headers.indexOf('asset');
  const quantityIndex = headers.indexOf('quantity');
  const priceIndex = headers.indexOf('price_usd');
  const feeIndex = headers.indexOf('fee');
  const noteIndex = headers.indexOf('note');

  const transactionsToSave = [];
  const idCounts = {}; // Track duplicate transaction IDs within the same file

  // First pass: count IDs to detect duplicates
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length <= 1) continue; // Skip empty rows
    const txId = row[txIdIndex] || '';
    if (txId) {
      idCounts[txId] = (idCounts[txId] || 0) + 1;
    }
  }

  // Second pass: parse, validate, and build records
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length <= 1) continue;

    const rawTxId = row[txIdIndex] || '';
    const rawTimestamp = row[timestampIndex] || '';
    const rawType = row[typeIndex] || '';
    const rawAsset = row[assetIndex] || '';
    const rawQuantity = row[quantityIndex] || '';
    const rawPrice = row[priceIndex] || '';
    const rawFee = row[feeIndex] || '';
    const rawNote = row[noteIndex] || '';

    const tx = {
      transactionId: rawTxId,
      source,
      rawTimestamp,
      rawAsset,
      rawQuantity,
      priceUsd: parseFloat(rawPrice) || null,
      fee: parseFloat(rawFee) || null,
      note: rawNote,
      importRunId,
      isValid: true,
      validationError: null
    };

    const errors = [];

    // Validation 1: Missing Transaction ID
    if (!rawTxId) {
      errors.push('Missing transaction_id');
    }

    // Validation 2: Duplicate Transaction ID in same source file
    if (rawTxId && idCounts[rawTxId] > 1) {
      errors.push(`Duplicate transaction ID '${rawTxId}' in ${source} source file`);
    }

    // Validation 3: Malformed or missing timestamp
    let parsedDate = null;
    if (!rawTimestamp) {
      errors.push('Missing timestamp');
    } else {
      parsedDate = new Date(rawTimestamp);
      if (isNaN(parsedDate.getTime())) {
        errors.push(`Malformed timestamp '${rawTimestamp}'`);
      } else {
        tx.timestamp = parsedDate;
      }
    }

    // Validation 4: Mapped transaction type validation
    const cleanType = rawType.toUpperCase().trim();
    const validTypes = ['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'];
    if (!cleanType) {
      errors.push('Missing transaction type');
    } else if (!validTypes.includes(cleanType)) {
      errors.push(`Invalid transaction type '${rawType}'`);
    } else {
      tx.type = cleanType;
    }

    // Validation 5: Asset validation
    if (!rawAsset) {
      errors.push('Missing asset');
    } else {
      tx.asset = normalizeAsset(rawAsset);
    }

    // Validation 6: Quantity validation
    if (!rawQuantity) {
      errors.push('Missing quantity');
    } else {
      const q = parseFloat(rawQuantity);
      if (isNaN(q)) {
        errors.push(`Malformed quantity '${rawQuantity}'`);
      } else if (q <= 0) {
        errors.push(`Invalid quantity ${q}: must be positive`);
      } else {
        tx.quantity = q;
      }
    }

    // Mark validation status
    if (errors.length > 0) {
      tx.isValid = false;
      tx.validationError = errors.join(', ');
    }

    transactionsToSave.push(tx);
  }

  // Bulk save all transactions (both valid and invalid)
  if (transactionsToSave.length > 0) {
    await db.saveTransactions(transactionsToSave);
  }

  const validCount = transactionsToSave.filter(t => t.isValid).length;
  const invalidCount = transactionsToSave.filter(t => !t.isValid).length;

  return {
    total: transactionsToSave.length,
    valid: validCount,
    invalid: invalidCount
  };
}

module.exports = {
  parseAndIngestCSV,
  normalizeAsset,
  parseCSVLine
};
