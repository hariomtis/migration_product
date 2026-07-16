const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMigrationTag,
  buildProductSetInput,
  handleMissingSourceProduct,
  mapGraphqlProduct,
  migrateProduct,
  migrateProductsFromDb,
  resolveHandleForTarget,
  syncVariantShelfLocationsGraphQL,
  syncInventoryLevelsGraphQL
} = require('../src/migrationService');

test('syncVariantShelfLocationsGraphQL copies source shelf locations to matched target variants', async () => {
  const calls = [];
  const result = await syncVariantShelfLocationsGraphQL({
    client: {
      async setMetafieldsGraphQL(metafields) {
        calls.push(metafields);
        return metafields.map((metafield, index) => ({ id: `metafield-${index}` }));
      }
    },
    sourceProduct: {
      variants: [
        { sku: 'SKU-1', shelf_location: { value: 'A-12', type: 'single_line_text_field' } },
        { sku: 'SKU-2', shelf_location: null }
      ]
    },
    targetProduct: {
      variants: [
        { graphqlId: 'gid://shopify/ProductVariant/22', sku: 'SKU-2' },
        { graphqlId: 'gid://shopify/ProductVariant/11', sku: 'SKU-1' }
      ]
    }
  });

  assert.equal(result.length, 1);
  assert.deepEqual(calls, [[{
    ownerId: 'gid://shopify/ProductVariant/11',
    namespace: 'metrocustom',
    key: 'shelf_location',
    value: 'A-12',
    type: 'single_line_text_field'
  }]]);
});

test('syncVariantShelfLocationsGraphQL also copies metrocustom.category', async () => {
  const calls = [];
  await syncVariantShelfLocationsGraphQL({
    client: {
      async setMetafieldsGraphQL(metafields) {
        calls.push(...metafields);
        return metafields;
      }
    },
    sourceProduct: {
      variants: [{ sku: 'SKU-1', category: { value: 'Competition', type: 'single_line_text_field' } }]
    },
    targetProduct: {
      variants: [{ graphqlId: 'gid://shopify/ProductVariant/11', sku: 'SKU-1' }]
    }
  });

  assert.deepEqual(calls, [{
    ownerId: 'gid://shopify/ProductVariant/11',
    namespace: 'metrocustom',
    key: 'category',
    value: 'Competition',
    type: 'single_line_text_field'
  }]);
});

test('syncInventoryLevelsGraphQL batches selected source inventory into one target location', async () => {
  const inventoryCalls = [];
  const result = await syncInventoryLevelsGraphQL({
    client: {
      async getLocationsGraphQL() {
        return [{ id: 'gid://shopify/Location/900', name: 'Warehouse' }];
      },
      async activateInventoryItemGraphQL() {},
      async setInventoryQuantitiesGraphQL(input) {
        inventoryCalls.push(input);
      }
    },
    sourceProduct: {
      id: '1',
      inventoryLocationId: '71683670247',
      variants: [
        { sku: 'A', title: 'A', inventory_quantity: 7, inventory_levels: [{ locationId: 'gid://shopify/Location/71683670247', locationName: 'Warehouse' }] },
        { sku: 'B', title: 'B', inventory_quantity: 3, inventory_levels: [{ locationId: 'gid://shopify/Location/71683670247', locationName: 'Warehouse' }] }
      ]
    },
    targetProduct: {
      id: '2',
      variants: [
        { sku: 'A', inventory_item_id: 'item-a', inventory_levels: [] },
        { sku: 'B', inventory_item_id: 'item-b', inventory_levels: [] }
      ]
    }
  });

  assert.equal(result.length, 2);
  assert.equal(inventoryCalls.length, 1);
  assert.deepEqual(inventoryCalls[0].quantities.map(({ locationId, quantity }) => ({ locationId, quantity })), [
    { locationId: 'gid://shopify/Location/900', quantity: 7 },
    { locationId: 'gid://shopify/Location/900', quantity: 3 }
  ]);
});

test('buildMigrationTag creates the required migration tag', () => {
  assert.equal(buildMigrationTag('source-store', 'target-store', 123), 'migrate_source_store_123');
});

test('buildProductSetInput creates the expected GraphQL productSet input', () => {
  const input = buildProductSetInput({
    id: 123,
    title: 'Sample product',
    handle: 'sample-product',
    tags: ['foo'],
    body_html: '<p>Test</p>',
    vendor: 'Acme',
    product_type: 'Goods',
    status: 'active',
    options: [{ name: 'Size', position: 1, values: ['M'] }],
    variants: [{
      option1: 'M',
      title: 'M',
      sku: 'SKU1',
      price: '19.99',
      inventory_quantity: 5,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: true,
      barcode: 'BAR-1',
      image: {
        src: 'https://example.com/a.jpg',
        alt: 'A'
      }
    }],
    images: [{ src: 'https://example.com/a.jpg', alt: 'A', position: 1 }]
  }, { sourceStoreName: 'source-store', targetStoreName: 'target-store', existingTargetProduct: null });

  assert.deepEqual(input.tags, ['foo', 'migrate_source_store_123']);
  assert.equal(input.handle, 'sample-product');
  assert.equal(input.status, 'ACTIVE');
  assert.equal(input.productOptions[0].name, 'Size');
  assert.equal(input.productOptions[0].values[0].name, 'M');
  assert.equal(input.variants[0].sku, 'SKU1');
  assert.equal(input.variants[0].inventoryPolicy, 'DENY');
  assert.equal(input.variants[0].optionValues[0].optionName, 'Size');
  assert.equal(input.variants[0].file.originalSource, 'https://example.com/a.jpg');
  assert.equal(input.files[0].originalSource, 'https://example.com/a.jpg');
});

test('mapGraphqlProduct preserves the source handle from GraphQL', () => {
  const product = mapGraphqlProduct({
    id: 'gid://shopify/Product/123',
    legacyResourceId: '123',
    title: 'Dolfin Winners Blitz Print Jammer',
    handle: 'dolfin-winners-blitz-print-jammer',
    descriptionHtml: '<p>Test</p>',
    vendor: 'Acme',
    productType: 'Swimwear',
    tags: ['foo'],
    status: 'ACTIVE',
    options: [],
    images: { edges: [] },
    variants: { edges: [] }
  }, '123');

  assert.equal(product.handle, 'dolfin-winners-blitz-print-jammer');
});

test('buildProductSetInput includes variant-only images in product files and links them to variants', () => {
  const input = buildProductSetInput({
    id: 456,
    title: 'Variant image product',
    handle: 'variant-image-product',
    tags: [],
    body_html: '<p>Test</p>',
    vendor: 'Acme',
    product_type: 'Goods',
    status: 'active',
    options: [{ name: 'Color', position: 1, values: ['Red'] }],
    variants: [{
      option1: 'Red',
      title: 'Red',
      sku: 'RED-1',
      price: '12.99',
      inventory_quantity: 2,
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: true,
      image: {
        src: 'https://example.com/variant-red.jpg',
        alt: 'Red variant'
      }
    }],
    images: []
  }, { sourceStoreName: 'source-store', targetStoreName: 'target-store', existingTargetProduct: null });

  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].originalSource, 'https://example.com/variant-red.jpg');
  assert.equal(input.variants[0].file.originalSource, 'https://example.com/variant-red.jpg');
});

test('buildProductSetInput does not reuse the same target variant id for multiple variants', () => {
  const input = buildProductSetInput({
    id: 123,
    title: 'Sample product',
    handle: 'sample-product',
    tags: ['foo'],
    body_html: '<p>Test</p>',
    vendor: 'Acme',
    product_type: 'Goods',
    status: 'active',
    options: [{ name: 'Size', position: 1, values: ['S', 'M'] }],
    variants: [
      {
        option1: 'S',
        title: 'Default Title',
        sku: '',
        price: '19.99',
        inventory_quantity: 5,
        inventory_policy: 'deny',
        requires_shipping: true,
        taxable: true
      },
      {
        option1: 'M',
        title: 'Default Title',
        sku: '',
        price: '21.99',
        inventory_quantity: 3,
        inventory_policy: 'deny',
        requires_shipping: true,
        taxable: true
      }
    ],
    images: []
  }, {
    sourceStoreName: 'source-store',
    targetStoreName: 'target-store',
    existingTargetProduct: {
      options: [
        {
          graphqlId: 'gid://shopify/ProductOption/1',
          name: 'Size',
          position: 1,
          values: ['S', 'M'],
          valueRecords: [
            { graphqlId: 'gid://shopify/ProductOptionValue/1', name: 'S' },
            { graphqlId: 'gid://shopify/ProductOptionValue/2', name: 'M' }
          ]
        }
      ],
      variants: [
        {
          graphqlId: 'gid://shopify/ProductVariant/11',
          title: 'Default Title',
          sku: '',
          option1: 'S',
          option2: '',
          option3: ''
        },
        {
          graphqlId: 'gid://shopify/ProductVariant/22',
          title: 'Default Title',
          sku: '',
          option1: 'M',
          option2: '',
          option3: ''
        }
      ]
    }
  });

  assert.equal(input.variants[0].id, 'gid://shopify/ProductVariant/11');
  assert.equal(input.variants[1].id, 'gid://shopify/ProductVariant/22');
  assert.notEqual(input.variants[0].id, input.variants[1].id);
});

test('resolveHandleForTarget keeps the existing target handle during updates', async () => {
  const handle = await resolveHandleForTarget({
    sourceProduct: {
      id: 123,
      title: 'Sample product',
      handle: 'sample-product'
    },
    existingTargetProduct: {
      handle: 'sample-product-existing'
    },
    targetClient: {
      async findProductByHandleGraphQL() {
        throw new Error('should not look up handles when updating an existing product');
      }
    },
    logger: () => {}
  });

  assert.equal(handle, 'sample-product-existing');
});

test('resolveHandleForTarget creates a suffixed handle when the preferred handle is already used', async () => {
  const seenCandidates = [];
  const handle = await resolveHandleForTarget({
    sourceProduct: {
      id: 987,
      title: 'Dolfin Winners Blitz Print Jammer',
      handle: 'dolfin-winners-blitz-print-jammer'
    },
    existingTargetProduct: null,
    targetClient: {
      async findProductByHandleGraphQL(candidate) {
        seenCandidates.push(candidate);
        if (candidate === 'dolfin-winners-blitz-print-jammer') {
          return { id: 'gid://shopify/Product/1' };
        }
        return null;
      }
    },
    logger: () => {}
  });

  assert.deepEqual(seenCandidates, [
    'dolfin-winners-blitz-print-jammer',
    'dolfin-winners-blitz-print-jammer-987'
  ]);
  assert.equal(handle, 'dolfin-winners-blitz-print-jammer-987');
});

test('handleMissingSourceProduct deletes the mapped target product and then removes the mapping row', async () => {
  const deletedIds = [];
  const deletedMappings = [];
  const callOrder = [];

  const result = await handleMissingSourceProduct({
    sourceProductId: '8101698011170',
    sourceStoreName: 'source-store',
    mapping: {
      mss_pro_id: '8101698011170',
      uss_pro_id: '9988776655'
    },
    targetStoreName: 'target-store',
    targetClient: {
      async getProductGraphQL(productId) {
        assert.equal(productId, '9988776655');
        return {
          id: 'gid://shopify/Product/9988776655',
          legacyResourceId: '9988776655',
          title: 'Mapped product',
          handle: 'mapped-product',
          descriptionHtml: '',
          vendor: 'Acme',
          productType: 'Goods',
          tags: [],
          status: 'ACTIVE',
          options: [],
          images: { edges: [] },
          variants: { edges: [] }
        };
      },
      async deleteProductGraphQL(productId) {
        callOrder.push('target');
        deletedIds.push(productId);
        return 'gid://shopify/Product/9988776655';
      }
    },
    logger: () => {},
    deleteMappingBySourceIdFn: async (sourceProductId) => {
      callOrder.push('mapping');
      deletedMappings.push(sourceProductId);
    }
  });

  assert.equal(result.action, 'deleted');
  assert.equal(result.isDeleted, true);
  assert.equal(result.isMigrated, false);
  assert.equal(result.isMappingDeleted, true);
  assert.equal(result.targetProductId, '9988776655');
  assert.deepEqual(deletedIds, ['9988776655']);
  assert.deepEqual(deletedMappings, ['8101698011170']);
  assert.deepEqual(callOrder, ['target', 'mapping']);
});

test('handleMissingSourceProduct falls back to the migration tag when no mapping row exists', async () => {
  const deletedIds = [];
  const deletedMappings = [];

  const result = await handleMissingSourceProduct({
    sourceProductId: '8101698011170',
    sourceStoreName: 'source-store',
    mapping: null,
    targetStoreName: 'target-store',
    targetClient: {
      async findProductByQueryGraphQL(searchQuery) {
        assert.equal(searchQuery, 'tag:migrate_source_store_8101698011170');
        return {
          id: 'gid://shopify/Product/9988776655',
          legacyResourceId: '9988776655',
          title: 'Mapped by tag',
          handle: 'mapped-by-tag',
          descriptionHtml: '',
          vendor: 'Acme',
          productType: 'Goods',
          tags: ['migrate_source_store_8101698011170'],
          status: 'ACTIVE',
          options: [],
          images: { edges: [] },
          variants: { edges: [] }
        };
      },
      async getProductGraphQL(productId) {
        assert.equal(productId, '9988776655');
        return {
          id: 'gid://shopify/Product/9988776655',
          legacyResourceId: '9988776655',
          title: 'Mapped by tag',
          handle: 'mapped-by-tag',
          descriptionHtml: '',
          vendor: 'Acme',
          productType: 'Goods',
          tags: ['migrate_source_store_8101698011170'],
          status: 'ACTIVE',
          options: [],
          images: { edges: [] },
          variants: { edges: [] }
        };
      },
      async deleteProductGraphQL(productId) {
        deletedIds.push(productId);
        return 'gid://shopify/Product/9988776655';
      }
    },
    logger: () => {},
    deleteMappingBySourceIdFn: async (sourceProductId) => {
      deletedMappings.push(sourceProductId);
    }
  });

  assert.equal(result.action, 'deleted');
  assert.equal(result.targetProductId, '9988776655');
  assert.equal(result.mapping.uss_pro_id, '9988776655');
  assert.deepEqual(deletedIds, ['9988776655']);
  assert.deepEqual(deletedMappings, ['8101698011170']);
});

test('migrateProduct falls back to missing-source cleanup when the source product no longer exists', async () => {
  const cleanupCalls = [];
  const cleanupResult = {
    action: 'deleted',
    isDeleted: true,
    isCreated: false,
    isUpdated: false,
    isMigrated: false,
    isMappingDeleted: true,
    sourceProductId: '8101698011170',
    targetProductId: '9988776655',
    targetProduct: null,
    logs: ['Deleted target product 9988776655'],
    mapping: {
      mss_pro_id: '8101698011170',
      uss_pro_id: '9988776655'
    }
  };

  const result = await migrateProduct({
    sourceProductId: '8101698011170',
    sourceStoreName: 'source-store',
    targetStoreName: 'target-store',
    sourceConfig: {},
    targetConfig: {},
    sourceClient: {
      async getProductGraphQL(productId) {
        assert.equal(productId, '8101698011170');
        return null;
      }
    },
    targetClient: {},
    getMappingBySourceIdFn: async (sourceProductId) => ({
      mss_pro_id: sourceProductId,
      uss_pro_id: '9988776655'
    }),
    handleMissingSourceProductFn: async (payload) => {
      cleanupCalls.push(payload);
      return cleanupResult;
    },
    logger: () => {}
  });

  assert.deepEqual(result, cleanupResult);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].mapping.uss_pro_id, '9988776655');
  assert.equal(cleanupCalls[0].sourceStoreName, 'source-store');
  assert.equal(cleanupCalls[0].targetStoreName, 'target-store');
});

test('migrateProductsFromDb processes every row up to the requested limit and returns summary counts', async () => {
  const mappings = Array.from({ length: 5 }, (_, index) => ({
    mss_pro_id: String(index + 1),
    uss_pro_id: null
  }));
  const processedIds = [];

  const result = await migrateProductsFromDb({
    limit: 5,
    concurrency: 2,
    sourceClient: {},
    targetClient: {},
    getPendingMappingsFn: async (limit) => {
      assert.equal(limit, 5);
      return mappings;
    },
    migrateProductFn: async ({ sourceProductId }) => {
      processedIds.push(sourceProductId);
      if (sourceProductId === '5') {
        throw new Error('test failure');
      }
      return {
        targetProductId: `target-${sourceProductId}`,
        action: sourceProductId === '4' ? 'updated' : 'created'
      };
    },
    logger: () => {}
  });

  assert.deepEqual(processedIds.sort(), ['1', '2', '3', '4', '5']);
  assert.equal(result.processedCount, 5);
  assert.equal(result.insertedCount, 3);
  assert.equal(result.createdCount, 3);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.successCount, 4);
  assert.equal(result.failureCount, 1);
});
