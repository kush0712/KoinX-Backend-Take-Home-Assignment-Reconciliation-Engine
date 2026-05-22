const path = require('path');

// Try to load dotenv, fail silently if not installed
try {
  require('dotenv').config();
} catch (e) {
  // Silent fallback if dotenv is not available
}

const config = {
  port: process.env.PORT || 3000,
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/koinx_reconciliation',
  timestampToleranceSeconds: parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS, 10) || 300,
  quantityTolerancePct: parseFloat(process.env.QUANTITY_TOLERANCE_PCT) || 0.01,
  userCsvPath: process.env.USER_CSV_PATH || path.join(__dirname, '../../user_transactions.csv'),
  exchangeCsvPath: process.env.EXCHANGE_CSV_PATH || path.join(__dirname, '../../exchange_transactions.csv')
};

module.exports = config;
