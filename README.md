# Transaction Reconciliation Engine - KoinX Backend Intern Assignment

Hey! This is my implementation for the KoinX Transaction Reconciliation Engine backend take-home assignment. 

I designed and built this in Node.js. It takes two messy CSV files (one from the user, one from the exchange), validates the dirty rows, runs a multi-phase matching algorithm with configurable tolerances, and spits out a detailed reconciliation report in CSV/JSON.

I focused heavily on writing clean, modular JS (avoiding bloated libraries where possible) and making sure the engine handles messy real-world crypto transaction edge cases robustly.

---

## 🛠️ Key Decisions & Clarifications on Unclear Requirements

While working through this assignment, I noticed a few tricky spots and ambiguous requirements. Here is how I decided to handle them:

### 1. Duplicate Transaction IDs in the Same File (Data Quality Issue)
*   **The Issue:** In `user_transactions.csv`, the transaction ID `USR-001` is duplicated (appears on line 2 and again on line 17). 
*   **My Decision:** In a real financial app, we shouldn't guess which duplicate row is the correct one, and we definitely shouldn't double-match them. I chose to flag **both** rows as invalid (`isValid: false`) in the database with the reason `Duplicate transaction ID in source file`. Because they are invalid, they are excluded from strict matching. Consequently, `EXC-1001` on the exchange side stays unmatched. This is the safest way to alert the user that they have duplicate exports that need a manual eyes-on check.

### 2. Mapped "Compatible" Types
*   **The Issue:** Type mapping needs to handle opposite perspectives for transfers.
*   **My Decision:** Direct trades (`BUY` to `BUY`, `SELL` to `SELL`) must match exactly. For transfers, they are recorded as opposites depending on who exported them:
    *   User `TRANSFER_OUT` matches Exchange `TRANSFER_IN` (sending coins from a personal wallet to the exchange).
    *   User `TRANSFER_IN` matches Exchange `TRANSFER_OUT` (withdrawing coins from the exchange to a personal wallet).
    I wrote a utility helper `areTypesCompatible` to handle this logic cleanly.

### 3. Defining "Proximity" for Conflicts
*   **The Issue:** The prompt says "Conflicting" transactions are *"matched by ID or proximity, but key fields (quantity, timestamp) differ beyond tolerance"*. But User transaction IDs (`USR-xxx`) and Exchange transaction IDs (`EXC-xxx`) follow completely different formats and can never match by ID.
*   **My Decision:** Since ID matching is impossible, I relied entirely on **proximity**. I defined a proximity match as: two transactions representing the same asset and compatible types that occur within a wider time window of **24 hours** (86,400 seconds). If two transactions fit this description but fail either the strict timestamp or quantity tolerance, they are paired as `conflicting`. I write a detailed reason explaining exactly what broke the threshold (e.g. `Quantity diff of 0.0333% exceeds tolerance of 0.01%`) so the user knows exactly where the records differ.

### 4. Quantity Tolerance Percentage Formula
*   **The Issue:** Does "0.01% quantity tolerance" calculate relative to the User's quantity or the Exchange's quantity?
*   **My Decision:** I chose to calculate the difference relative to the **User's reported quantity**: `|Qty_User - Qty_Exchange| / Qty_User * 100 <= Tolerance`. Since the user's file represents their own book of records, it is the logical baseline to measure discrepancies against.

### 5. Ingestion of Malformed Data
*   **The Issue:** Do not silently drop bad rows.
*   **My Decision:** The parser reads the files and performs 6 detailed validations per row (checking for empty IDs, duplicate IDs, invalid ISO dates, unsupported action types, missing assets, and negative or non-numeric quantities). Instead of throwing errors and crashing the run or skipping rows, the parser saves the bad rows to the database with `isValid: false` and list all reasons in a `validationError` field. This keeps the data fully visible in the runs.

### 6. Sandbox Port-Binding & Database Resiliency (The "Dual Mode" Trick)
*   **The Issue:** In some restricted terminal environments (like isolated VM sandboxes), binding TCP/Unix listener sockets throws `EPERM` errors, and the lack of internet makes running `npm install` for Mongoose or Express fail.
*   **My Decision:** I wanted this engine to run perfectly on *any* computer right out of the box. So, I structured the app with a **Repository Pattern**. If the app cannot connect to MongoDB or if `mongoose`/`express` modules aren't installed, it automatically falls back to an **In-Memory Datastore** and an **In-Memory Route Dispatcher** that behaves exactly like the real HTTP routes. This allowed me to write and run a full integration test suite without needing a single dependency! In a real production setup with Node and MongoDB, it boots instantly as a standard Express.js server connected to a real MongoDB instance.

---

## 📂 File Structure

*   `src/config/config.js` — Loads env variables and sets up default tolerances (`300s`, `0.01%`).
*   `src/db/schemas.js` — Production-ready MongoDB Mongoose models for Transactions, Runs, and Entries.
*   `src/db/database.js` — Hybrid DB Service layer (Mongoose MongoDB wrapper + In-Memory repository fallback).
*   `src/parser/csvParser.js` — Custom, zero-dependency CSV line splitter and validator.
*   `src/engine/matchingEngine.js` — Core reconciliation logic (Strict matching + Proximity conflict pairing + Unmatched tracking).
*   `src/controllers/reconcileController.js` — REST controller handling CSV generation and JSON summaries.
*   `src/routes/reconcileRoutes.js` — Defines API routes (supports Express routers and mock router metadata).
*   `src/app.js` — Main application config (boots standard Express or pure Node MockApp fallback).
*   `src/index.js` — Server entrance point, wrapped in a socket error boundary.
*   `tests/runner.js` — Custom, color-coded, zero-dependency unit and integration test suite.

---

## 🚀 How to Set Up & Run

### Prerequisites
- [Node.js](https://nodejs.org/) (v16.0.0+ recommended)
- [MongoDB](https://www.mongodb.com/) (Optional — runs in-memory if MongoDB is down)

### 1. Project Setup
Clone this repo and install dependencies:
```bash
npm install
```

### 2. Start the API Server
Run the production Express web server (which connects to MongoDB at `mongodb://127.0.0.1:27017/koinx_reconciliation` by default):
```bash
npm start
```
*(If you run this inside a VM/sandbox that blocks socket binds, it will warn you and run in secure sandbox mode instead of crashing.)*

### 3. Run the Automated Tests
I wrote a comprehensive test suite in `tests/runner.js` that verifies everything—ingestion validations, asset mapping, quantity/timestamp tolerances, perspective mapping, conflict flagging, and REST requests.

You can run it instantly using standard Node without setting up databases or installing node modules:
```bash
npm test
```

---

## 📡 REST API Documentation

### 1. Trigger Reconciliation Run
Ingests both CSV files, stores all transaction rows (flagging the bad ones), executes the matching engine, and saves the reports.

- **URL:** `/reconcile`
- **Method:** `POST`
- **Body (Optional custom tolerance overrides):**
  ```json
  {
    "timestampToleranceSeconds": 300,
    "quantityTolerancePct": 0.05
  }
  ```
- **Response (`201 Created`):**
  ```json
  {
    "runId": "db4e43cf-1fae-4f3b-ba23-66276ab0a0b2",
    "timestamp": "2026-05-23T01:50:00.123Z",
    "config": {
      "timestampToleranceSeconds": 300,
      "quantityTolerancePct": 0.05
    },
    "summary": {
      "matched": 21,
      "conflicting": 0,
      "unmatchedUser": 0,
      "unmatchedExchange": 4,
      "invalidUserRows": 5,
      "invalidExchangeRows": 0
    }
  }
  ```

### 2. Download Full Reconciliation Report (CSV)
Streams the generated reconciliation report as a CSV file.

- **URL:** `/report/:runId`
- **Method:** `GET`
- **Response (`200 OK` with headers `Content-Type: text/csv`):**
  A CSV file showing the category and matching reason, side-by-side with original columns from the user and exchange:
  ```csv
  category,reason,user_transaction_id,user_timestamp,user_type,user_asset,user_quantity,user_price_usd,user_fee,user_note,exchange_transaction_id,exchange_timestamp,exchange_type,exchange_asset,exchange_quantity,exchange_price_usd,exchange_fee,exchange_note
  matched,Matched within tolerances (Timestamp diff: 32.00s, Quantity diff: 0.0000%),USR-002,2024-03-01T11:30:00.000Z,BUY,ETH,2,3400,0.002,,EXC-1002,2024-03-01T11:30:00.000Z,BUY,ETH,2,3400,0.002,
  conflicting,Conflict: Quantity diff of 0.0333% exceeds tolerance of 0.01% (User: 0.3, Exchange: 0.3001),USR-012,2024-03-06T13:30:00.000Z,BUY,BTC,0.3,62500,0.0003,,EXC-1012,2024-03-06T13:30:00.000Z,BUY,BTC,0.3001,62500,0.0003,
  ```

### 3. Fetch Summary counts
- **URL:** `/report/:runId/summary`
- **Method:** `GET`
- **Response (`200 OK`):**
  ```json
  {
    "runId": "db4e43cf-1fae-4f3b-ba23-66276ab0a0b2",
    "summary": {
      "matched": 20,
      "conflicting": 1,
      "unmatchedUser": 0,
      "unmatchedExchange": 4
    }
  }
  ```

### 4. Fetch Unmatched Transactions with Reasons
- **URL:** `/report/:runId/unmatched`
- **Method:** `GET`
- **Response (`200 OK`):**
  ```json
  {
    "runId": "db4e43cf-1fae-4f3b-ba23-66276ab0a0b2",
    "unmatchedCount": 4,
    "unmatchedUser": [],
    "unmatchedExchange": [
      {
        "transaction": {
          "transactionId": "EXC-1001",
          "source": "exchange",
          "timestamp": "2024-03-01T09:00:32.000Z",
          "type": "BUY",
          "asset": "BTC",
          "quantity": 0.5,
          "priceUsd": 62000,
          "fee": 0.0005,
          "importRunId": "db4e43cf-1fae-4f3b-ba23-66276ab0a0b2"
        },
        "reason": "No matching transaction found in user records for the same asset, type, and timeframe"
      }
    ]
  }
  ```
