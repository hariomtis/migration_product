const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { migrateProductsFromDb } = require('../src/migrationService');
const { initDb } = require('../src/db');

const {
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

function parseLimitArg() {
  const rawValue = process.argv[2];
  if (!rawValue) {
    return 20;
  }

  const limit = Number(rawValue);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer. Example: node script/migrate.js 20');
  }

  return limit;
}

async function main() {
  if (!SOURCE_SHOP_DOMAIN || !SOURCE_ACCESS_TOKEN || !TARGET_SHOP_DOMAIN || !TARGET_ACCESS_TOKEN) {
    throw new Error('Missing Shopify credentials in .env');
  }

  if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_DATABASE) {
    throw new Error('Missing database credentials in .env');
  }

  const requestedLimit = parseLimitArg();
  await initDb();
  let batch;
  do {
    batch = await migrateProductsFromDb({
      limit: requestedLimit,
      concurrency: Number(MIGRATION_CONCURRENCY) || 3,
      sourceInventoryLocationId: SOURCE_INVENTORY_LOCATION_ID || '71683670247',
      targetInventoryLocationId: TARGET_INVENTORY_LOCATION_ID || undefined,
      sourceStoreName: SOURCE_STORE_NAME || 'source',
      targetStoreName: TARGET_STORE_NAME || 'target',
      sourceConfig: { shop: SOURCE_SHOP_DOMAIN, accessToken: SOURCE_ACCESS_TOKEN },
      targetConfig: { shop: TARGET_SHOP_DOMAIN, accessToken: TARGET_ACCESS_TOKEN },
      logger: (message) => console.log(`[migration] ${message}`)
    });
    console.log(`Processed ${batch.count} products (${batch.successCount} successful, ${batch.failureCount} failed).`);
  } while (batch.count === requestedLimit && batch.successCount > 0);

  console.log(JSON.stringify(batch, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
