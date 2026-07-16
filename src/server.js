require('dotenv').config();
const express = require('express');
const { migrateProduct, migrateAllProducts, migrateProductsFromDb } = require('./migrationService');
const { initDb } = require('./db');

const app = express();
app.use(express.json());

const {
  PORT,
  SOURCE_SHOP_DOMAIN,
  SOURCE_ACCESS_TOKEN,
  TARGET_SHOP_DOMAIN,
  TARGET_ACCESS_TOKEN,
  SOURCE_STORE_NAME,
  TARGET_STORE_NAME,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_DATABASE,
  SOURCE_INVENTORY_LOCATION_ID,
  TARGET_INVENTORY_LOCATION_ID,
  MIGRATION_CONCURRENCY
} = process.env;

if (!SOURCE_SHOP_DOMAIN || !SOURCE_ACCESS_TOKEN || !TARGET_SHOP_DOMAIN || !TARGET_ACCESS_TOKEN) {
  throw new Error('Missing Shopify credentials in .env');
}

if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_DATABASE) {
  throw new Error('Missing database credentials in .env');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/migrate-product', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }

    const result = await migrateProduct({
      sourceProductId: productId,
      sourceStoreName: SOURCE_STORE_NAME || 'source',
      targetStoreName: TARGET_STORE_NAME || 'target',
      sourceConfig: {
        shop: SOURCE_SHOP_DOMAIN,
        accessToken: SOURCE_ACCESS_TOKEN
      },
      targetConfig: {
        shop: TARGET_SHOP_DOMAIN,
        accessToken: TARGET_ACCESS_TOKEN
      },
      logger: (message) => console.log(`[migration] ${message}`)
    });

    res.json(result);
  } catch (error) {
    console.error(error.message || error);
    res.status(500).json({ error: error.message || 'Migration failed' });
  }
});

app.post('/migrate-all-products', async (_req, res) => {
  try {
    const results = await migrateAllProducts({
      sourceStoreName: SOURCE_STORE_NAME || 'source',
      targetStoreName: TARGET_STORE_NAME || 'target',
      sourceConfig: {
        shop: SOURCE_SHOP_DOMAIN,
        accessToken: SOURCE_ACCESS_TOKEN
      },
      targetConfig: {
        shop: TARGET_SHOP_DOMAIN,
        accessToken: TARGET_ACCESS_TOKEN
      },
      logger: (message) => console.log(`[migration] ${message}`)
    });

    res.json({ count: results.length, results });
  } catch (error) {
    console.error(error.message || error);
    res.status(500).json({ error: error.message || 'Migration failed' });
  }
});

app.post('/from_db', async (req, res) => {
  try {
    const requestedLimit = req.query?.limit ?? req.body?.limit ?? 20;
    const limit = Number(requestedLimit);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 250) {
      return res.status(400).json({
        error: 'limit must be a positive integer between 1 and 250'
      });
    }

    const results = await migrateProductsFromDb({
      limit,
      concurrency: Number(MIGRATION_CONCURRENCY) || 3,
      sourceInventoryLocationId: SOURCE_INVENTORY_LOCATION_ID || '71683670247',
      targetInventoryLocationId: TARGET_INVENTORY_LOCATION_ID || undefined,
      sourceStoreName: SOURCE_STORE_NAME || 'source',
      targetStoreName: TARGET_STORE_NAME || 'target',
      sourceConfig: {
        shop: SOURCE_SHOP_DOMAIN,
        accessToken: SOURCE_ACCESS_TOKEN
      },
      targetConfig: {
        shop: TARGET_SHOP_DOMAIN,
        accessToken: TARGET_ACCESS_TOKEN
      },
      logger: (message) => console.log(`[migration] ${message}`)
    });

    res.json(results);
  } catch (error) {
    console.error(error.message || error);
    res.status(500).json({ error: error.message || 'Migration failed' });
  }
});

async function startServer() {
  await initDb();
  const requestedPort = Number(PORT) || 3000;
  const maxPortAttempts = 10;

  const listen = (port, attempt = 1) => {
    const server = app.listen(port);

    server.once('listening', () => {
      console.log(`Server listening on port ${port}`);
      if (port !== requestedPort) {
        console.log(`Port ${requestedPort} was occupied; using fallback port ${port}`);
      }
    });

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && attempt < maxPortAttempts) {
        const nextPort = port + 1;
        console.warn(`Port ${port} is already in use; trying port ${nextPort}`);
        listen(nextPort, attempt + 1);
        return;
      }

      if (error.code === 'EADDRINUSE') {
        console.error(`Could not find a free port after trying ${requestedPort}-${port}.`);
      } else {
        console.error('Server error:', error);
      }
      process.exitCode = 1;
    });

    return server;
  };

  return listen(requestedPort);
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
