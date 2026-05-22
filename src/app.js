let express;
try {
  express = require('express');
} catch (e) {
  express = null;
}

class MockResponse {
  constructor(cb) {
    this.cb = cb;
    this.statusCode = 200;
    this.headers = {};
    this.body = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name] = value;
    return this;
  }

  json(data) {
    this.body = data;
    this.setHeader('Content-Type', 'application/json');
    if (this.cb) this.cb(this);
    return this;
  }

  send(data) {
    this.body = data;
    if (this.cb) this.cb(this);
    return this;
  }
}

class MockExpressApp {
  constructor() {
    this.routes = require('./routes/reconcileRoutes');
    this.isMock = true;
    console.log('API App running in: PURE NODE MOCK DISPATCH MODE (No Express required)');
  }

  async dispatch({ method, url, body = {} }) {
    const req = { method, url, body, params: {} };
    let matchedRoute = null;

    for (const route of this.routes) {
      if (route.method !== method) continue;

      if (route.path.includes('/:')) {
        const pathParts = route.path.split('/');
        const urlParts = url.split('?')[0].split('/');

        if (pathParts.length === urlParts.length) {
          let matches = true;
          const params = {};

          for (let i = 0; i < pathParts.length; i++) {
            if (pathParts[i].startsWith(':')) {
              params[pathParts[i].substring(1)] = urlParts[i];
            } else if (pathParts[i] !== urlParts[i]) {
              matches = false;
              break;
            }
          }

          if (matches) {
            req.params = params;
            matchedRoute = route;
            break;
          }
        }
      } else {
        if (route.path === url.split('?')[0]) {
          matchedRoute = route;
          break;
        }
      }
    }

    if (!matchedRoute) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Not Found' }
      };
    }

    return new Promise((resolve) => {
      const res = new MockResponse((finalRes) => {
        resolve({
          statusCode: finalRes.statusCode,
          headers: finalRes.headers,
          body: finalRes.body
        });
      });

      try {
        matchedRoute.handler(req, res);
      } catch (err) {
        resolve({
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: { error: err.message }
        });
      }
    });
  }
}

let app;

if (express) {
  const controller = require('./controllers/reconcileController');
  app = express();
  app.use(express.json());

  // Root landing page — registered directly on app to guarantee it always works
  app.get('/', controller.getRoot);

  // Register all other API routes
  const reconcileRoutes = require('./routes/reconcileRoutes');
  app.use('/', reconcileRoutes);
  
  app.isMock = false;
} else {
  app = new MockExpressApp();
}

module.exports = app;
