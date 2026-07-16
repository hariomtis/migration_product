# Shopify Product Migration App

This Express app migrates products from one Shopify store to another using the Shopify Admin GraphQL API only.

## What it does
- Checks whether the product already exists in the target store.
- Updates it if it exists, otherwise creates it.
- Adds a migration tag in the format `migrate_<store>_<product_id>`.
- Migrates product-level, variant-level, inventory-level, and image data.
- Logs whether each product was created or updated.
- Uses GraphQL for product lookup, create/update, product listing, location lookup, and inventory sync.
- Marks `isMigrated = 1` in `uss_mss_products_map_table` after a mapped product is migrated successfully.

## Environment variables
Copy the sample environment file and fill in your store details:

```bash
cp .env.example .env
```

Then edit the values for:
- `SOURCE_SHOP_DOMAIN`
- `SOURCE_ACCESS_TOKEN`
- `TARGET_SHOP_DOMAIN`
- `TARGET_ACCESS_TOKEN`
- `SOURCE_STORE_NAME`
- `TARGET_STORE_NAME`
- `SOURCE_INVENTORY_LOCATION_ID` (defaults to `71683670247`)
- `TARGET_INVENTORY_LOCATION_ID` (optional; otherwise matches by location name)
- `MIGRATION_CONCURRENCY` (defaults to `3`)
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_DATABASE`

The app uses the `uss_mss_products_map_table` table to determine whether the target product exists by `uss_pro_id`. If a mapping exists, the source product is updated in the target store. Otherwise, the target product is created. Inventory is copied only from the configured source location and written to the configured target location (or a target location with the same name). Variant metafields `metrocustom.shelf_location` and `metrocustom.category` are copied. When a mapped migration succeeds, the app updates `isMigrated` to `1`.

## Run
```bash
npm install
npm start
```

## API
### Migrate one product
```bash
curl -X POST http://localhost:3000/migrate-product \
  -H "Content-Type: application/json" \
  -d '{"productId": 12345}'
```

### Migrate all products
```bash
curl -X POST http://localhost:3000/migrate-all-products
```

### Migrate 20 pending products from DB
```bash
curl -X POST http://localhost:3000/from_db \
  -H "Content-Type: application/json" \
  -d '{"limit": 20}'

# The limit can also be supplied as a query parameter:
curl -X POST "http://localhost:3000/from_db?limit=20"
```

This API reads up to 20 rows from `uss_mss_products_map_table` where `isMigrated` is `0` or `NULL`, migrates them one by one, and sets `isMigrated = 1` after each successful migration.
The final response includes `processedCount`, `insertedCount` (new target products),
`updatedCount`, `successCount`, and `failureCount`.
