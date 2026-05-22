let mongoose;
try {
  mongoose = require('mongoose');
} catch (e) {
  mongoose = null;
}

if (mongoose) {
  const TransactionSchema = new mongoose.Schema({
    transactionId: { type: String, required: true },
    source: { type: String, enum: ['user', 'exchange'], required: true },
    timestamp: { type: Date },
    rawTimestamp: { type: String },
    type: { type: String, required: true },
    asset: { type: String, required: true },
    rawAsset: { type: String },
    quantity: { type: Number },
    rawQuantity: { type: String },
    priceUsd: { type: Number },
    fee: { type: Number },
    note: { type: String },
    isValid: { type: Boolean, default: true },
    validationError: { type: String },
    importRunId: { type: String, required: true }
  }, { timestamps: true });

  const ReconciliationRunSchema = new mongoose.Schema({
    runId: { type: String, required: true, unique: true },
    timestamp: { type: Date, default: Date.now },
    config: {
      timestampToleranceSeconds: { type: Number, required: true },
      quantityTolerancePct: { type: Number, required: true }
    },
    summary: {
      matched: { type: Number, default: 0 },
      conflicting: { type: Number, default: 0 },
      unmatchedUser: { type: Number, default: 0 },
      unmatchedExchange: { type: Number, default: 0 },
      invalidUserRows: { type: Number, default: 0 },
      invalidExchangeRows: { type: Number, default: 0 }
    }
  }, { timestamps: true });

  const ReconciliationReportEntrySchema = new mongoose.Schema({
    entryId: { type: String, required: true, unique: true },
    runId: { type: String, required: true },
    category: { type: String, enum: ['matched', 'conflicting', 'unmatched_user', 'unmatched_exchange'], required: true },
    reason: { type: String, required: true },
    userTransaction: { type: mongoose.Schema.Types.Mixed },
    exchangeTransaction: { type: mongoose.Schema.Types.Mixed }
  }, { timestamps: true });

  module.exports = {
    Transaction: mongoose.model('Transaction', TransactionSchema),
    ReconciliationRun: mongoose.model('ReconciliationRun', ReconciliationRunSchema),
    ReconciliationReportEntry: mongoose.model('ReconciliationReportEntry', ReconciliationReportEntrySchema)
  };
} else {
  module.exports = {
    Transaction: null,
    ReconciliationRun: null,
    ReconciliationReportEntry: null
  };
}
