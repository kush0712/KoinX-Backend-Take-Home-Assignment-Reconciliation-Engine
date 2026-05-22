let express;
try {
  express = require('express');
} catch (e) {
  express = null;
}

const controller = require('../controllers/reconcileController');

if (express) {
  const router = express.Router();

  // Route declarations
  router.post('/reconcile', controller.reconcile);
  router.get('/reconcile', controller.reconcile); // GET fallback for easy browser testing
  router.get('/report/:runId', controller.getReport);
  router.get('/report/:runId/summary', controller.getSummary);
  router.get('/report/:runId/unmatched', controller.getUnmatched);

  module.exports = router;
} else {
  // Pure JS mock routing mapping metadata for in-memory testing
  module.exports = [
    { method: 'POST', path: '/reconcile', handler: controller.reconcile },
    { method: 'GET', path: '/reconcile', handler: controller.reconcile },
    { method: 'GET', path: '/report/:runId', handler: controller.getReport },
    { method: 'GET', path: '/report/:runId/summary', handler: controller.getSummary },
    { method: 'GET', path: '/report/:runId/unmatched', handler: controller.getUnmatched }
  ];
}
