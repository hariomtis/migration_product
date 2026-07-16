const { createShopifyClient } = require('./shopifyClient');
const { query: dbQuery } = require('./db');

function sanitizeTagSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildMigrationTag(sourceStoreName, _targetStoreName, sourceProductId) {
  const sourceTag = sanitizeTagSegment(sourceStoreName || 'source');
  return `migrate_${sourceTag}_${sourceProductId}`;
}

function normalizeTags(tags) {
  return (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((tag) => String(tag).trim())
    .filter(Boolean);
}

function mergeTags(existingTags, migrationTag) {
  const tags = normalizeTags(existingTags);
  if (!tags.includes(migrationTag)) {
    tags.push(migrationTag);
  }
  return tags.join(', ');
}

function cleanObject(payload) {
  return Object.entries(payload).reduce((result, [key, value]) => {
    if (value === null || value === undefined) {
      return result;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return result;
    }
    if (Array.isArray(value) && value.length === 0) {
      return result;
    }
    result[key] = value;
    return result;
  }, {});
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function buildPreferredHandle(sourceProduct) {
  return sourceProduct.handle || slugify(sourceProduct.title || `product-${sourceProduct.id}`);
}

function truncateHandle(handle, maxLength = 255) {
  return String(handle || '').slice(0, maxLength).replace(/-+$/g, '');
}

function appendHandleSuffix(baseHandle, suffix) {
  const normalizedSuffix = slugify(String(suffix || 'copy'));
  if (!normalizedSuffix) {
    return truncateHandle(baseHandle);
  }

  const separator = '-';
  const truncatedBase = truncateHandle(baseHandle, 255 - normalizedSuffix.length - separator.length);
  return truncateHandle(`${truncatedBase}${separator}${normalizedSuffix}`);
}

function extractNumericId(graphqlId) {
  const match = /\/(\d+)$/.exec(String(graphqlId || ''));
  return match ? match[1] : null;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const amount = Number(value);
  return Number.isFinite(amount) ? amount : undefined;
}

function normalizeStatus(status) {
  if (!status) {
    return 'active';
  }

  const normalized = String(status).toLowerCase();
  if (normalized === 'active' || normalized === 'draft' || normalized === 'archived') {
    return normalized;
  }

  return 'active';
}

function normalizeGraphqlStatus(status) {
  return normalizeStatus(status).toUpperCase();
}

function normalizeInventoryPolicy(policy) {
  const normalized = String(policy || 'deny').toLowerCase();
  return normalized === 'continue' ? 'CONTINUE' : 'DENY';
}

function normalizeProductOptions(graphqlOptions, mappedVariants) {
  const options = (graphqlOptions || []).map((option) => {
    const rawValues = option.values || option.optionValues || [];
    const values = rawValues
      .map((value) => (typeof value === 'string' ? value : value?.name))
      .filter((value) => typeof value === 'string' && value.trim() !== '');

    return {
      graphqlId: option.id || null,
      name: option.name,
      position: option.position,
      values,
      valueRecords: (option.optionValues || [])
        .map((value) => ({
          graphqlId: value.id || null,
          name: value.name
        }))
        .filter((value) => value.name)
    };
  }).filter((option) => option.name && option.values.length);

  if (options.length) {
    return options;
  }

  return [
    {
      graphqlId: null,
      name: 'Title',
      position: 1,
      values: Array.from(new Set(mappedVariants.map((variant) => variant.option1 || variant.title || 'Default Title'))),
      valueRecords: []
    }
  ];
}

function getVariantOption(node, optionIndex) {
  const selected = (node.selectedOptions || [])[optionIndex];
  return selected?.value || selected?.optionValue?.name || '';
}

function getAvailableQuantity(quantities = []) {
  const quantity = quantities.find((entry) => entry.name === 'available');
  return Number(quantity?.quantity ?? 0);
}

function extractVariantImage(node) {
  const mediaImage = (node.media?.edges || [])
    .map(({ node: mediaNode }) => mediaNode)
    .find((mediaNode) => mediaNode?.image?.url);

  if (!mediaImage?.image?.url) {
    return null;
  }

  return {
    src: mediaImage.image.url,
    alt: mediaImage.alt || ''
  };
}

function normalizeImage(image, position = 1) {
  if (!image?.src) {
    return null;
  }

  return {
    src: image.src,
    alt: image.alt || '',
    position
  };
}

function buildFileKey(image) {
  return `${image.src}::${image.alt || ''}`;
}

function collectProductFiles(sourceProduct) {
  const files = [];
  const seen = new Set();

  for (const [index, image] of (sourceProduct.images || []).entries()) {
    const normalizedImage = normalizeImage(image, index + 1);
    if (!normalizedImage) {
      continue;
    }

    const key = buildFileKey(normalizedImage);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    files.push(normalizedImage);
  }

  for (const variant of (sourceProduct.variants || [])) {
    const normalizedImage = normalizeImage(variant.image);
    if (!normalizedImage) {
      continue;
    }

    const key = buildFileKey(normalizedImage);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    files.push({
      ...normalizedImage,
      position: files.length + 1
    });
  }

  return files;
}

function locationIdMatches(graphqlId, locationId) {
  return String(graphqlId || '') === String(locationId || '') || extractNumericId(graphqlId) === String(locationId || '');
}

function mapGraphqlProduct(sourceProduct, sourceProductId, { inventoryLocationId } = {}) {
  const resolvedProductId = String(sourceProduct?.legacyResourceId || sourceProductId || extractNumericId(sourceProduct?.id) || '');

  const variants = (sourceProduct.variants?.edges || []).map(({ node }, index) => ({
    id: String(node.legacyResourceId || extractNumericId(node.id) || ''),
    graphqlId: node.id,
    inventory_item_id: node.inventoryItem?.id || null,
    inventory_levels: (node.inventoryItem?.inventoryLevels?.edges || []).map(({ node: inventoryLevel }) => ({
      locationId: inventoryLevel.location?.id || null,
      locationName: inventoryLevel.location?.name || null,
      available: getAvailableQuantity(inventoryLevel.quantities)
    })),
    option1: getVariantOption(node, 0) || node.title || 'Default Title',
    option2: getVariantOption(node, 1) || '',
    option3: getVariantOption(node, 2) || '',
    title: node.title || '',
    sku: node.sku || '',
    price: node.price || '0.00',
    compare_at_price: node.compareAtPrice || null,
    inventory_management: node.inventoryItem?.tracked ? 'shopify' : null,
    inventory_policy: String(node.inventoryPolicy || 'deny').toLowerCase(),
    barcode: node.barcode || '',
    taxable: node.taxable !== false,
    shelf_location: node.shelfLocation ? {
      value: node.shelfLocation.value,
      type: node.shelfLocation.type
    } : null,
    category: node.category ? {
      value: node.category.value,
      type: node.category.type
    } : null,
    image: extractVariantImage(node),
    fulfillment_service: 'manual',
    requires_shipping: node.inventoryItem?.requiresShipping !== false,
    inventory_quantity: inventoryLocationId
      ? getAvailableQuantity(
        (node.inventoryItem?.inventoryLevels?.edges || [])
          .find(({ node: level }) => locationIdMatches(level.location?.id, inventoryLocationId))?.node?.quantities || []
      )
      : (node.inventoryQuantity ?? 0),
    position: index + 1
  }));

  return {
    id: resolvedProductId,
    graphqlId: sourceProduct.id || null,
    title: sourceProduct.title,
    handle: sourceProduct.handle || slugify(sourceProduct.title || `product-${resolvedProductId}`),
    body_html: sourceProduct.descriptionHtml || '',
    vendor: sourceProduct.vendor || '',
    product_type: sourceProduct.productType || '',
    tags: normalizeTags(sourceProduct.tags),
    status: normalizeStatus(sourceProduct.status),
    options: normalizeProductOptions(sourceProduct.options, variants),
    variants,
    images: (sourceProduct.images?.edges || []).map(({ node }, index) => ({
      src: node.originalSrc || node.src || '',
      alt: node.altText || '',
      position: index + 1
    })).filter((image) => image.src)
  };
}

function getVariantOptionTuple(variant) {
  return [variant.option1 || '', variant.option2 || '', variant.option3 || ''];
}

function hasMeaningfulOptionMatch(sourceVariant, targetVariant) {
  const sourceOptions = getVariantOptionTuple(sourceVariant);
  const targetOptions = getVariantOptionTuple(targetVariant);
  const hasAnyOptionValue = sourceOptions.some(Boolean) || targetOptions.some(Boolean);

  return hasAnyOptionValue && sourceOptions.every((value, index) => value === targetOptions[index]);
}

function getVariantMatchScore(sourceVariant, targetVariant) {
  if (targetVariant.sku && sourceVariant.sku && targetVariant.sku === sourceVariant.sku) {
    return 3;
  }

  if (hasMeaningfulOptionMatch(sourceVariant, targetVariant)) {
    return 2;
  }

  if (targetVariant.title && sourceVariant.title && targetVariant.title === sourceVariant.title) {
    return 1;
  }

  return 0;
}

function matchVariantsUniquely(sourceVariants = [], targetVariants = []) {
  if (!Array.isArray(sourceVariants) || !Array.isArray(targetVariants)) {
    return [];
  }

  const usedTargetVariantIds = new Set();

  return sourceVariants.map((sourceVariant) => {
    let bestMatch = null;
    let bestScore = 0;

    for (const targetVariant of targetVariants) {
      if (usedTargetVariantIds.has(targetVariant.graphqlId)) {
        continue;
      }

      const score = getVariantMatchScore(sourceVariant, targetVariant);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = targetVariant;
      }
    }

    if (bestMatch?.graphqlId) {
      usedTargetVariantIds.add(bestMatch.graphqlId);
    }

    return bestMatch;
  });
}

function findMatchingVariant(targetVariants = [], sourceVariant) {
  return matchVariantsUniquely([sourceVariant], targetVariants)[0] || null;
}

function buildResolvedOptions(sourceProduct, existingTargetProduct) {
  return (sourceProduct.options || []).map((option) => {
    const existingOption = (existingTargetProduct?.options || []).find((candidate) => candidate.name === option.name);

    return {
      graphqlId: existingOption?.graphqlId || null,
      name: option.name,
      position: option.position,
      values: (option.values || []).map((value) => {
        const existingValue = (existingOption?.valueRecords || []).find((candidate) => candidate.name === value);
        return {
          graphqlId: existingValue?.graphqlId || null,
          name: value
        };
      }).filter((value) => value.name)
    };
  }).filter((option) => option.name && option.values.length);
}

function buildVariantOptionValues(variant, resolvedOptions) {
  return resolvedOptions.map((option, index) => {
    const selectedValue = [variant.option1, variant.option2, variant.option3][index] || '';
    const matchedValue = option.values.find((value) => value.name === selectedValue);

    if (matchedValue?.graphqlId && option.graphqlId) {
      return {
        id: matchedValue.graphqlId,
        optionId: option.graphqlId
      };
    }

    return {
      optionName: option.name,
      name: selectedValue || matchedValue?.name || 'Default Title'
    };
  }).filter((value) => value.optionName || value.id);
}

async function resolveHandleForTarget({ sourceProduct, existingTargetProduct, targetClient, logger = console.log }) {
  const preferredHandle = truncateHandle(buildPreferredHandle(sourceProduct));

  if (existingTargetProduct?.handle) {
    return existingTargetProduct.handle;
  }

  if (!preferredHandle) {
    return preferredHandle;
  }

  const fallbackSuffixes = [sourceProduct.id, `${sourceProduct.id}-2`, `${sourceProduct.id}-3`, `${sourceProduct.id}-4`];
  const candidates = [preferredHandle];

  for (const suffix of fallbackSuffixes) {
    const candidate = appendHandleSuffix(preferredHandle, suffix);
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  for (const candidate of candidates) {
    const matchedProduct = await targetClient.findProductByHandleGraphQL(candidate);
    if (!matchedProduct) {
      if (candidate !== preferredHandle) {
        logger(`Resolved handle conflict for ${preferredHandle}; using ${candidate}`);
      }
      return candidate;
    }
  }

  const lastResortHandle = appendHandleSuffix(preferredHandle, `${sourceProduct.id || 'copy'}-${Date.now()}`);
  logger(`Resolved repeated handle conflict for ${preferredHandle}; using ${lastResortHandle}`);
  return lastResortHandle;
}

function buildProductSetInput(sourceProduct, { sourceStoreName, targetStoreName, existingTargetProduct }) {
  const migrationTag = buildMigrationTag(sourceStoreName, targetStoreName, sourceProduct.id);
  const resolvedOptions = buildResolvedOptions(sourceProduct, existingTargetProduct);
  const matchedVariants = matchVariantsUniquely(sourceProduct.variants || [], existingTargetProduct?.variants || []);
  const productFiles = collectProductFiles(sourceProduct);

  const variants = (sourceProduct.variants || []).map((variant, index) => {
    const matchedVariant = matchedVariants[index] || null;
    const inventoryItem = cleanObject({
      tracked: variant.inventory_quantity !== null && variant.inventory_quantity !== undefined,
      requiresShipping: variant.requires_shipping !== false
    });
    const variantImage = productFiles.find((image) => image.src === variant.image?.src) || null;

    return cleanObject({
      id: matchedVariant?.graphqlId,
      position: variant.position || index + 1,
      price: parseMoney(variant.price) ?? 0,
      compareAtPrice: parseMoney(variant.compare_at_price),
      sku: variant.sku || undefined,
      barcode: variant.barcode || undefined,
      taxable: variant.taxable !== false,
      inventoryPolicy: normalizeInventoryPolicy(variant.inventory_policy),
      inventoryItem: Object.keys(inventoryItem).length ? inventoryItem : undefined,
      file: variantImage ? cleanObject({
        originalSource: variantImage.src,
        alt: variantImage.alt || undefined
      }) : undefined,
      optionValues: buildVariantOptionValues(variant, resolvedOptions)
    });
  });

  return cleanObject({
    title: sourceProduct.title,
    descriptionHtml: sourceProduct.body_html || '',
    vendor: sourceProduct.vendor || '',
    productType: sourceProduct.product_type || '',
    handle: sourceProduct.resolvedHandle || buildPreferredHandle(sourceProduct),
    tags: normalizeTags(mergeTags(sourceProduct.tags, migrationTag)),
    status: normalizeGraphqlStatus(sourceProduct.status),
    productOptions: resolvedOptions.map((option) => cleanObject({
      id: option.graphqlId,
      name: option.name,
      position: option.position,
      values: option.values.map((value) => cleanObject({
        id: value.graphqlId,
        name: value.name
      }))
    })),
    variants,
    files: productFiles.map((image) => cleanObject({
      originalSource: image.src,
      alt: image.alt || undefined
    })).filter((image) => image.originalSource)
  });
}

function getCurrentInventoryQuantity(targetVariant, locationId) {
  const level = (targetVariant.inventory_levels || []).find((entry) => entry.locationId === locationId);
  if (!level) {
    return null;
  }
  return Number(level.available ?? 0);
}

function buildInventoryReference(sourceProductId, targetProductId) {
  return `gid://migration-product/ProductMigration/${sourceProductId}-${targetProductId || 'pending'}`;
}

async function syncInventoryLevelsGraphQL({ client, targetProduct, sourceProduct, targetLocationId }) {
  const locations = await client.getLocationsGraphQL();
  if (!locations.length) {
    return [];
  }

  const sourceLocationName = (sourceProduct.variants || [])
    .flatMap((variant) => variant.inventory_levels || [])
    .find((level) => locationIdMatches(level.locationId, sourceProduct.inventoryLocationId))?.locationName;
  const targetLocation = targetLocationId
    ? locations.find((location) => locationIdMatches(location.id, targetLocationId))
    : locations.find((location) => sourceLocationName && location.name === sourceLocationName) || locations[0];

  if (!targetLocation) {
    throw new Error(`Target inventory location ${targetLocationId || sourceLocationName || ''} was not found`);
  }

  const results = [];
  const quantities = [];
  const activations = [];
  const matchedVariants = matchVariantsUniquely(sourceProduct.variants || [], targetProduct.variants || []);

  for (const [index, sourceVariant] of (sourceProduct.variants || []).entries()) {
    const targetVariant = matchedVariants[index] || null;
    if (!targetVariant?.inventory_item_id) {
      continue;
    }

    const quantity = Number(sourceVariant.inventory_quantity || 0);
    const currentQuantity = getCurrentInventoryQuantity(targetVariant, targetLocation.id);

    if (currentQuantity === null) {
      activations.push(client.activateInventoryItemGraphQL({
          inventoryItemId: targetVariant.inventory_item_id,
          locationId: targetLocation.id,
          available: 0
      }));
    }

    quantities.push({
      inventoryItemId: targetVariant.inventory_item_id,
      locationId: targetLocation.id,
      quantity,
      compareQuantity: currentQuantity === null ? 0 : currentQuantity
    });

      results.push({
        variantTitle: sourceVariant.title,
        locationId: targetLocation.id,
        inventoryItemId: targetVariant.inventory_item_id,
        quantity
      });
  }

  await Promise.all(activations);
  for (let index = 0; index < quantities.length; index += 250) {
    await client.setInventoryQuantitiesGraphQL({
      referenceDocumentUri: buildInventoryReference(sourceProduct.id, targetProduct.id),
      quantities: quantities.slice(index, index + 250)
    });
  }

  return results;
}

async function syncVariantShelfLocationsGraphQL({ client, targetProduct, sourceProduct }) {
  const matchedVariants = matchVariantsUniquely(sourceProduct.variants || [], targetProduct.variants || []);
  const metafields = (sourceProduct.variants || []).flatMap((sourceVariant, index) => {
    const targetVariant = matchedVariants[index];
    if (!targetVariant?.graphqlId) {
      return [];
    }

    return [
      ['shelf_location', sourceVariant.shelf_location],
      ['category', sourceVariant.category]
    ].flatMap(([key, metafield]) => metafield?.value === null || metafield?.value === undefined ? [] : [cleanObject({
        ownerId: targetVariant.graphqlId,
        namespace: 'metrocustom',
        key,
        value: String(metafield.value),
        type: metafield.type
      })]);
  });

  const results = [];
  for (let index = 0; index < metafields.length; index += 25) {
    const batch = metafields.slice(index, index + 25);
    results.push(...await client.setMetafieldsGraphQL(batch));
  }

  return results;
}

async function getMappingBySourceId(sourceProductId) {
  const rows = await dbQuery(
    'SELECT * FROM uss_mss_products_map_table WHERE mss_pro_id = ? LIMIT 1',
    [sourceProductId]
  );
  return rows[0] || null;
}

async function getPendingMappings(limit = 20) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 250));
  return dbQuery(
    `SELECT DISTINCT mss_pro_id, uss_pro_id
     FROM uss_mss_products_map_table
     WHERE isMigrated IS NULL OR isMigrated = 0
     ORDER BY mss_pro_id ASC
     LIMIT ${normalizedLimit}`
  );
}

async function markMappingMigrated({ sourceProductId, targetProductId }) {
  if (!sourceProductId) {
    return;
  }

  if (targetProductId) {
    await dbQuery(
      'UPDATE uss_mss_products_map_table SET isMigrated = 1, uss_pro_id = ? WHERE mss_pro_id = ?',
      [targetProductId, sourceProductId]
    );
    return;
  }

  await dbQuery(
    'UPDATE uss_mss_products_map_table SET isMigrated = 1 WHERE mss_pro_id = ?',
    [sourceProductId]
  );
}

async function deleteMappingBySourceId(sourceProductId) {
  if (!sourceProductId) {
    return;
  }

  await dbQuery(
    'DELETE FROM uss_mss_products_map_table WHERE mss_pro_id = ?',
    [sourceProductId]
  );
}

async function handleMissingSourceProduct({
  sourceProductId,
  sourceStoreName,
  mapping,
  targetStoreName,
  targetClient,
  logger = console.log,
  deleteMappingBySourceIdFn = deleteMappingBySourceId
}) {
  let resolvedMapping = mapping || null;
  let mappedTargetProductId = resolvedMapping?.uss_pro_id ? String(resolvedMapping.uss_pro_id).trim() : '';

  if (!mappedTargetProductId) {
    const migrationTag = buildMigrationTag(sourceStoreName, targetStoreName, sourceProductId);
    logger(`Source product ${sourceProductId} was not found via GraphQL; no mapping row found, searching target by tag ${migrationTag}`);

    const fallbackTarget = await targetClient.findProductByQueryGraphQL(`tag:${migrationTag}`);
    if (fallbackTarget) {
      mappedTargetProductId = String(fallbackTarget.legacyResourceId || extractNumericId(fallbackTarget.id) || '').trim();
      resolvedMapping = {
        ...(resolvedMapping || {}),
        mss_pro_id: String(sourceProductId),
        uss_pro_id: mappedTargetProductId
      };
      logger(`Found target product ${mappedTargetProductId} using migration tag fallback ${migrationTag}`);
    }
  }

  mappedTargetProductId = mappedTargetProductId || null;
  logger(`Source product ${sourceProductId} was not found via GraphQL; cleaning up mapping row`);

  const logs = [];
  let targetProduct = null;
  let action = 'mapping_deleted';

  if (mappedTargetProductId) {
    logger(`Checking mapped target product ${mappedTargetProductId} before deleting mapping row`);

    const rawTargetProduct = await targetClient.getProductGraphQL(mappedTargetProductId);
    targetProduct = rawTargetProduct
      ? mapGraphqlProduct(rawTargetProduct, mappedTargetProductId)
      : null;

    if (targetProduct) {
      await targetClient.deleteProductGraphQL(mappedTargetProductId);
      action = 'deleted';
      logs.push(`Deleted target product ${mappedTargetProductId} from ${targetStoreName} because source product ${sourceProductId} no longer exists`);
      logger(`Deleted mapped target product ${mappedTargetProductId}`);
    } else {
      action = 'already_deleted';
      logs.push(`Mapped target product ${mappedTargetProductId} was already missing in ${targetStoreName}`);
      logger(`Mapped target product ${mappedTargetProductId} was already missing in target store`);
    }
  } else {
    logs.push(`No mapped target product id was stored for source product ${sourceProductId}`);
    logger(`No mapped target product id found; deleting only the mapping row for source product ${sourceProductId}`);
  }

  await deleteMappingBySourceIdFn(String(sourceProductId));

  logger(`Deleted mapping row for source product ${sourceProductId} after missing-source cleanup`);
  logs.push(`Deleted mapping row for source product ${sourceProductId}`);

  for (const log of logs) {
    logger(log);
  }

  return {
    action,
    isDeleted: action === 'deleted',
    isCreated: false,
    isUpdated: false,
    isMigrated: false,
    isMappingDeleted: true,
    sourceProductId: String(sourceProductId),
    targetProductId: mappedTargetProductId,
    targetProduct,
    logs,
    mapping: resolvedMapping
  };
}

async function migrateProduct(config) {
  const {
    sourceProductId,
    sourceStoreName,
    targetStoreName,
    sourceConfig,
    targetConfig,
    logger = console.log,
    sourceClient: injectedSourceClient,
    targetClient: injectedTargetClient,
    getMappingBySourceIdFn = getMappingBySourceId,
    handleMissingSourceProductFn = handleMissingSourceProduct
  } = config;
  const sourceInventoryLocationId = config.sourceInventoryLocationId || '71683670247';

  const sourceClient = injectedSourceClient || createShopifyClient(sourceConfig);
  const targetClient = injectedTargetClient || createShopifyClient(targetConfig);

  const mapping = await getMappingBySourceIdFn(sourceProductId);
  logger(`Looking up mapping for source product ${sourceProductId}`);

  const rawSourceProduct = await sourceClient.getProductGraphQL(sourceProductId);
  if (!rawSourceProduct) {
    return handleMissingSourceProductFn({
      sourceProductId,
      sourceStoreName,
      mapping,
      targetStoreName,
      targetClient,
      logger
    });
  }
  logger(`Fetched source product ${sourceProductId} from GraphQL`);

  const sourceProduct = mapGraphqlProduct(rawSourceProduct, sourceProductId, {
    inventoryLocationId: sourceInventoryLocationId
  });
  sourceProduct.inventoryLocationId = sourceInventoryLocationId;

  let existingTargetProduct = null;
  if (mapping?.uss_pro_id) {
    existingTargetProduct = await targetClient.getProductGraphQL(mapping.uss_pro_id);
    if (existingTargetProduct) {
      existingTargetProduct = mapGraphqlProduct(existingTargetProduct, mapping.uss_pro_id);
      logger(`Found target product by mapping id ${mapping.uss_pro_id}`);
    } else {
      logger(`Mapping target product id ${mapping.uss_pro_id} not found in target store`);
    }
  }

  if (!existingTargetProduct && sourceProduct.handle) {
    const fallbackTarget = await targetClient.findProductByHandleGraphQL(sourceProduct.handle);
    if (fallbackTarget) {
      existingTargetProduct = mapGraphqlProduct(fallbackTarget, fallbackTarget.legacyResourceId || extractNumericId(fallbackTarget.id));
      logger(`Found target product by handle fallback: ${sourceProduct.handle}`);
    }
  }

  sourceProduct.resolvedHandle = await resolveHandleForTarget({
    sourceProduct,
    existingTargetProduct,
    targetClient,
    logger
  });

  const productSetInput = buildProductSetInput(sourceProduct, {
    sourceStoreName,
    targetStoreName,
    existingTargetProduct
  });

  const targetProductResponse = await targetClient.setProductGraphQL({
    input: productSetInput,
    identifier: existingTargetProduct?.graphqlId ? { id: existingTargetProduct.graphqlId } : null
  });

  const targetProduct = mapGraphqlProduct(targetProductResponse, targetProductResponse?.legacyResourceId || extractNumericId(targetProductResponse?.id));
  const logs = [];

  logs.push(
    `${existingTargetProduct ? 'Updated' : 'Created'} product ${targetProduct.title} (${targetProduct.id}) in ${targetStoreName}`
  );

  if (targetProduct?.id) {
    const metafieldResults = await syncVariantShelfLocationsGraphQL({
      client: targetClient,
      targetProduct,
      sourceProduct
    });
    logs.push(`Synced ${metafieldResults.length} variant metafields`);

    const inventoryResults = await syncInventoryLevelsGraphQL({
      client: targetClient,
      targetProduct,
      sourceProduct,
      targetLocationId: config.targetInventoryLocationId
    });
    logs.push(`Synced inventory for ${inventoryResults.length} variant/location records`);
  }

  const result = {
    action: existingTargetProduct ? 'updated' : 'created',
    isUpdated: Boolean(existingTargetProduct),
    isCreated: !existingTargetProduct,
    sourceProductId: String(sourceProductId),
    targetProductId: targetProduct?.id || null,
    targetProduct,
    logs,
    mapping
  };

  if (mapping && result.targetProductId) {
    await markMappingMigrated({
      sourceProductId: String(sourceProductId),
      targetProductId: String(result.targetProductId)
    });
    result.isMigrated = true;
    logger(`Marked source product ${sourceProductId} as migrated in uss_mss_products_map_table`);
  }

  for (const log of logs) {
    logger(log);
  }

  logger(`Migration result: sourceProductId=${sourceProductId}, targetProductId=${result.targetProductId}, action=${result.action}`);

  return result;
}

async function migrateAllProducts(config) {
  const { sourceConfig } = config;
  const sourceClient = createShopifyClient(sourceConfig);
  const products = await sourceClient.getAllProductsGraphQL();
  const results = [];

  for (const product of products) {
    const sourceId = String(product.legacyResourceId || extractNumericId(product.id) || '');
    if (!sourceId) {
      continue;
    }

    const result = await migrateProduct({
      ...config,
      sourceProductId: sourceId
    });
    results.push(result);
  }

  return results;
}

function sleep(ms) {
  console.log("Sleep function triggered for", ms, "milliseconds");
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function migrateProductsFromDb(config) {
  const {
    logger = console.log,
    limit = 20
  } = config;

  const getPendingMappingsFn = config.getPendingMappingsFn || getPendingMappings;
  const migrateProductFn = config.migrateProductFn || migrateProduct;
  const mappings = await getPendingMappingsFn(limit);
  const sourceClient = config.sourceClient || createShopifyClient(config.sourceConfig);
  const targetClient = config.targetClient || createShopifyClient(config.targetConfig);
  const concurrency = Math.max(1, Math.min(Number(config.concurrency) || 3, 8));

  async function migrateMapping(mapping) {
    const sourceProductId = String(mapping.mss_pro_id || '').trim();
    if (!sourceProductId) {
      return {
        status: 'failed',
        error: 'mss_pro_id is missing on mapping row',
        mapping
      };
    }

    try {
      const result = await migrateProductFn({
        ...config,
        sourceProductId,
        sourceClient,
        targetClient,
        getMappingBySourceIdFn: async () => mapping
      });

      return {
        status: 'success',
        sourceProductId,
        targetProductId: result.targetProductId,
        action: result.action,
        isMigrated: true
      };
    } catch (error) {
      logger(`Failed to migrate source product ${sourceProductId} from mapping table: ${error.message || error}`);
      return {
        status: 'failed',
        sourceProductId,
        error: error.message || String(error)
      };
    }
  }

  const results = [];
  for (let index = 0; index < mappings.length; index += concurrency) {
    results.push(...await Promise.all(mappings.slice(index, index + concurrency).map(migrateMapping)));
  }

  const successfulResults = results.filter((result) => result.status === 'success');

  return {
    processedCount: results.length,
    insertedCount: successfulResults.filter((result) => result.action === 'created').length,
    createdCount: successfulResults.filter((result) => result.action === 'created').length,
    updatedCount: successfulResults.filter((result) => result.action === 'updated').length,
    count: results.length,
    successCount: successfulResults.length,
    failureCount: results.filter((result) => result.status === 'failed').length,
    results
  };
}

module.exports = {
  buildMigrationTag,
  mergeTags,
  buildProductSetInput,
  migrateProduct,
  migrateAllProducts,
  migrateProductsFromDb,
  mapGraphqlProduct,
  slugify,
  buildPreferredHandle,
  appendHandleSuffix,
  resolveHandleForTarget,
  handleMissingSourceProduct,
  syncVariantShelfLocationsGraphQL,
  syncInventoryLevelsGraphQL
};
