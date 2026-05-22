const config = require('../config/config');
const schemas = require('./schemas');

let mongoose;
try {
  mongoose = require('mongoose');
} catch (e) {
  mongoose = null;
}

class InMemoryDatabaseService {
  constructor() {
    this.transactions = [];
    this.runs = [];
    this.entries = [];
    console.log('Database running in: IN-MEMORY FALLBACK MODE (zero-dependency, perfect for testing!)');
  }

  async connect() {
    // Already connected in-memory
    return true;
  }

  async saveTransactions(transactions) {
    this.transactions.push(...transactions);
    return transactions;
  }

  async getTransactions(query = {}) {
    return this.transactions.filter(tx => {
      for (const key in query) {
        if (tx[key] !== query[key]) return false;
      }
      return true;
    });
  }

  async saveReconciliationRun(run) {
    const existingIndex = this.runs.findIndex(r => r.runId === run.runId);
    if (existingIndex >= 0) {
      this.runs[existingIndex] = run;
    } else {
      this.runs.push(run);
    }
    return run;
  }

  async getReconciliationRun(runId) {
    return this.runs.find(r => r.runId === runId) || null;
  }

  async saveReportEntries(entries) {
    this.entries.push(...entries);
    return entries;
  }

  async getReportEntries(query = {}) {
    return this.entries.filter(entry => {
      for (const key in query) {
        if (entry[key] !== query[key]) return false;
      }
      return true;
    });
  }

  async clearAll() {
    this.transactions = [];
    this.runs = [];
    this.entries = [];
  }
}

class MongoDatabaseService {
  constructor() {
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) return true;
    try {
      await mongoose.connect(config.mongodbUri, {
        serverSelectionTimeoutMS: 2000 // fail fast if mongo is not running
      });
      this.isConnected = true;
      console.log('Database running in: MONGODB PRODUCTION MODE (Successfully connected to ' + config.mongodbUri + ')');
      return true;
    } catch (err) {
      console.warn('MongoDB connection failed: ' + err.message);
      console.warn('Falling back to In-Memory Database Service.');
      throw err; // will trigger fallback in DB initializer
    }
  }

  async saveTransactions(transactions) {
    return await schemas.Transaction.insertMany(transactions);
  }

  async getTransactions(query = {}) {
    return await schemas.Transaction.find(query).lean();
  }

  async saveReconciliationRun(run) {
    return await schemas.ReconciliationRun.findOneAndUpdate(
      { runId: run.runId },
      run,
      { upsert: true, new: true }
    );
  }

  async getReconciliationRun(runId) {
    return await schemas.ReconciliationRun.findOne({ runId }).lean();
  }

  async saveReportEntries(entries) {
    return await schemas.ReconciliationReportEntry.insertMany(entries);
  }

  async getReportEntries(query = {}) {
    return await schemas.ReconciliationReportEntry.find(query).lean();
  }

  async clearAll() {
    await schemas.Transaction.deleteMany({});
    await schemas.ReconciliationRun.deleteMany({});
    await schemas.ReconciliationReportEntry.deleteMany({});
  }
}

// Instantiate the active database service
let activeDbService;

function initDatabase() {
  if (activeDbService) return activeDbService;

  if (mongoose && process.env.USE_IN_MEMORY_DB !== 'true') {
    activeDbService = new MongoDatabaseService();
    // Try to connect, if it fails, fall back to InMemory
    activeDbService.connect().catch(() => {
      activeDbService = new InMemoryDatabaseService();
    });
  } else {
    activeDbService = new InMemoryDatabaseService();
  }
  return activeDbService;
}

module.exports = {
  getDb: initDatabase,
  InMemoryDatabaseService,
  MongoDatabaseService
};
