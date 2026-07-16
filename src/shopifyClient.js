const axios = require('axios');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

const PRODUCT_IMAGE_SELECTION = `
  id
  originalSrc
  altText
`;

const PRODUCT_VARIANT_SELECTION = `
  id
  legacyResourceId
  title
  sku
  price
  compareAtPrice
  barcode
  inventoryQuantity
  inventoryPolicy
  taxable
  shelfLocation: metafield(namespace: "metrocustom", key: "shelf_location") {
    value
    type
  }
  category: metafield(namespace: "metrocustom", key: "category") {
    value
    type
  }
  media(first: 10) {
    edges {
      node {
        ... on MediaImage {
          id
          alt
          image {
            url
          }
        }
      }
    }
  }
  selectedOptions {
    name
    value
    optionValue {
      id
      name
    }
  }
  inventoryItem {
    id
    sku
    tracked
    requiresShipping
    inventoryLevels(first: 250) {
      edges {
        node {
          location {
            id
            name
          }
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

function buildPageInfoSelection(includeConnectionPageInfo) {
  if (!includeConnectionPageInfo) {
    return '';
  }

  return `
    pageInfo {
      hasNextPage
      endCursor
    }
  `;
}

function buildProductSelection({ includeConnectionPageInfo = false } = {}) {
  return `
    id
    legacyResourceId
    title
    handle
    descriptionHtml
    vendor
    productType
    tags
    status
    options {
      id
      name
      position
      optionValues {
        id
        name
      }
    }
    images(first: 250) {
      edges {
        node {
${PRODUCT_IMAGE_SELECTION}
        }
      }
${buildPageInfoSelection(includeConnectionPageInfo)}
    }
    variants(first: 250) {
      edges {
        node {
${PRODUCT_VARIANT_SELECTION}
        }
      }
${buildPageInfoSelection(includeConnectionPageInfo)}
    }
  `;
}

const PRODUCT_SELECTION = buildProductSelection();
const PRODUCT_SELECTION_WITH_PAGE_INFO = buildProductSelection({ includeConnectionPageInfo: true });

function mergePaginatedConnection(existingConnection = {}, nextConnection = {}) {
  return {
    edges: [...(existingConnection.edges || []), ...(nextConnection.edges || [])],
    pageInfo: nextConnection.pageInfo || existingConnection.pageInfo || {
      hasNextPage: false,
      endCursor: null
    }
  };
}

function formatMutationUserErrors(errors = []) {
  return errors
    .map((error) => {
      const field = Array.isArray(error.field) ? error.field.join('.') : error.field;
      const prefix = field ? `${field}: ` : '';
      const code = error.code ? `${error.code} - ` : '';
      return `${prefix}${code}${error.message}`;
    })
    .join('; ');
}

function normalizeGraphqlId(resourceType, id) {
  if (!id) {
    return null;
  }

  const value = String(id);
  if (value.startsWith('gid://')) {
    return value;
  }

  return `gid://shopify/${resourceType}/${value}`;
}

function getConnectionPageInfo(connection) {
  return connection?.pageInfo || {
    hasNextPage: false,
    endCursor: null
  };
}

function createShopifyClient({ shop, accessToken }) {
  const client = axios.create({
    baseURL: `https://${shop}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    }
  });

  function formatShopifyError(error) {
    if (error?.response?.data) {
      const responseData = error.response.data;
      if (Array.isArray(responseData.errors)) {
        return responseData.errors.map((err) => err.message || JSON.stringify(err)).join('; ');
      }
      if (typeof responseData.errors === 'object') {
        return Object.entries(responseData.errors)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
          .join('; ');
      }
      if (typeof responseData.message === 'string') {
        return responseData.message;
      }
      return JSON.stringify(responseData);
    }

    return error.message || String(error);
  }

  async function graphql(query, variables = {}) {
    try {
      const { data } = await client.post('/graphql.json', { query, variables });
      if (data.errors?.length) {
        throw new Error(data.errors.map((error) => error.message).join('; '));
      }
      return data.data;
    } catch (error) {
      throw new Error(formatShopifyError(error));
    }
  }

  async function getProductVariantsPageGraphQL(productId, cursor = null) {
    const query = `query productVariantsPage($id: ID!, $cursor: String) {\n  product(id: $id) {\n    id\n    variants(first: 250, after: $cursor) {\n      edges {\n        node {\n${PRODUCT_VARIANT_SELECTION}\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}`;
    const data = await graphql(query, {
      id: normalizeGraphqlId('Product', productId),
      cursor
    });
    return data.product?.variants || null;
  }

  async function getProductImagesPageGraphQL(productId, cursor = null) {
    const query = `query productImagesPage($id: ID!, $cursor: String) {\n  product(id: $id) {\n    id\n    images(first: 250, after: $cursor) {\n      edges {\n        node {\n${PRODUCT_IMAGE_SELECTION}\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n}`;
    const data = await graphql(query, {
      id: normalizeGraphqlId('Product', productId),
      cursor
    });
    return data.product?.images || null;
  }

  async function hydrateProductConnections(product) {
    if (!product?.id) {
      return product || null;
    }

    const hydratedProduct = {
      ...product,
      images: {
        edges: [...(product.images?.edges || [])],
        pageInfo: getConnectionPageInfo(product.images)
      },
      variants: {
        edges: [...(product.variants?.edges || [])],
        pageInfo: getConnectionPageInfo(product.variants)
      }
    };

    while (hydratedProduct.images.pageInfo.hasNextPage) {
      const nextImages = await getProductImagesPageGraphQL(product.id, hydratedProduct.images.pageInfo.endCursor);
      if (!nextImages) {
        throw new Error(`Failed to load additional images for product ${product.id}`);
      }
      hydratedProduct.images = mergePaginatedConnection(hydratedProduct.images, nextImages);
    }

    while (hydratedProduct.variants.pageInfo.hasNextPage) {
      const nextVariants = await getProductVariantsPageGraphQL(product.id, hydratedProduct.variants.pageInfo.endCursor);
      if (!nextVariants) {
        throw new Error(`Failed to load additional variants for product ${product.id}`);
      }
      hydratedProduct.variants = mergePaginatedConnection(hydratedProduct.variants, nextVariants);
    }

    return hydratedProduct;
  }

  async function getProductGraphQL(productId) {
    const query = `query productById($id: ID!) {\n  product(id: $id) {\n${PRODUCT_SELECTION_WITH_PAGE_INFO}\n  }\n}`;
    const data = await graphql(query, { id: normalizeGraphqlId('Product', productId) });
    return hydrateProductConnections(data.product || null);
  }

  async function findProductByHandleGraphQL(handle) {
    const query = `query productByHandle($query: String!) {\n  products(first: 1, query: $query) {\n    edges {\n      node {\n${PRODUCT_SELECTION_WITH_PAGE_INFO}\n      }\n    }\n  }\n}`;
    const data = await graphql(query, { query: `handle:${handle}` });
    const product = data.products?.edges?.[0]?.node || null;
    return hydrateProductConnections(product);
  }

  async function findProductByQueryGraphQL(searchQuery) {
    const query = `query productBySearchQuery($query: String!) {\n  products(first: 1, query: $query) {\n    edges {\n      node {\n${PRODUCT_SELECTION_WITH_PAGE_INFO}\n      }\n    }\n  }\n}`;
    const data = await graphql(query, { query: searchQuery });
    const product = data.products?.edges?.[0]?.node || null;
    return hydrateProductConnections(product);
  }

  return {
    graphql,
    getProductGraphQL,
    findProductByQueryGraphQL,
    findProductByHandleGraphQL,
    async deleteProductGraphQL(productId) {
      const mutation = `mutation deleteProduct($input: ProductDeleteInput!) {\n  productDelete(input: $input) {\n    deletedProductId\n    userErrors {\n      field\n      message\n    }\n  }\n}`;
      const data = await graphql(mutation, {
        input: {
          id: normalizeGraphqlId('Product', productId)
        }
      });

      const payload = data.productDelete;
      if (payload.userErrors?.length) {
        throw new Error(formatMutationUserErrors(payload.userErrors));
      }

      return payload.deletedProductId || null;
    },
    async getAllProductsGraphQL() {
      const products = [];
      let cursor = null;

      const query = `query productsPage($cursor: String) {\n  products(first: 250, after: $cursor, sortKey: ID) {\n    edges {\n      cursor\n      node {\n        id\n        legacyResourceId\n        title\n        handle\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}`;

      while (true) {
        const data = await graphql(query, { cursor });
        const connection = data.products;
        const pageProducts = (connection?.edges || []).map(({ node }) => node);
        products.push(...pageProducts);

        if (!connection?.pageInfo?.hasNextPage) {
          break;
        }

        cursor = connection.pageInfo.endCursor;
      }

      return products;
    },
    async getLocationsGraphQL() {
      const locations = [];
      let cursor = null;

      const query = `query locationsPage($cursor: String) {\n  locations(first: 250, after: $cursor) {\n    edges {\n      node {\n        id\n        name\n      }\n    }\n    pageInfo {\n      hasNextPage\n      endCursor\n    }\n  }\n}`;

      while (true) {
        const data = await graphql(query, { cursor });
        const connection = data.locations;
        locations.push(...((connection?.edges || []).map(({ node }) => node)));

        if (!connection?.pageInfo?.hasNextPage) {
          break;
        }

        cursor = connection.pageInfo.endCursor;
      }

      return locations;
    },
    async setProductGraphQL({ input, identifier }) {
      const mutation = `mutation setProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {\n  productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {\n    product {\n${PRODUCT_SELECTION}\n    }\n    userErrors {\n      code\n      field\n      message\n    }\n  }\n}`;
      const data = await graphql(mutation, {
        input,
        identifier: identifier || null,
        synchronous: true
      });

      const payload = data.productSet;
      if (payload.userErrors?.length) {
        throw new Error(formatMutationUserErrors(payload.userErrors));
      }

      if (!payload.product?.id) {
        return payload.product || null;
      }

      // productSet already returns the complete product selection. Avoid a second
      // large product query for every migrated item.
      return payload.product;
    },
    async setMetafieldsGraphQL(metafields) {
      const mutation = `mutation setMetafields($metafields: [MetafieldsSetInput!]!) {\n  metafieldsSet(metafields: $metafields) {\n    metafields {\n      id\n      namespace\n      key\n      value\n      type\n      ownerType\n    }\n    userErrors {\n      code\n      field\n      message\n    }\n  }\n}`;
      const data = await graphql(mutation, { metafields });
      const payload = data.metafieldsSet;

      if (payload.userErrors?.length) {
        throw new Error(formatMutationUserErrors(payload.userErrors));
      }

      return payload.metafields || [];
    },
    async activateInventoryItemGraphQL({ inventoryItemId, locationId, available = 0 }) {
      const mutation = `mutation activateInventory($inventoryItemId: ID!, $locationId: ID!, $available: Int) {\n  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {\n    inventoryLevel {\n      location {\n        id\n      }\n      quantities(names: ["available"]) {\n        name\n        quantity\n      }\n      item {\n        id\n      }\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}`;
      const data = await graphql(mutation, {
        inventoryItemId,
        locationId,
        available
      });

      const payload = data.inventoryActivate;
      if (payload.userErrors?.length) {
        throw new Error(formatMutationUserErrors(payload.userErrors));
      }

      return payload.inventoryLevel || null;
    },
    async setInventoryQuantitiesGraphQL({ name = 'available', reason = 'correction', referenceDocumentUri, quantities }) {
      const mutation = `mutation setInventoryQuantities($input: InventorySetQuantitiesInput!) {\n  inventorySetQuantities(input: $input) {\n    inventoryAdjustmentGroup {\n      reason\n      referenceDocumentUri\n      changes {\n        name\n        delta\n        quantityAfterChange\n      }\n    }\n    userErrors {\n      code\n      field\n      message\n    }\n  }\n}`;
      const data = await graphql(mutation, {
        input: {
          name,
          reason,
          referenceDocumentUri,
          quantities
        }
      });

      const payload = data.inventorySetQuantities;
      if (payload.userErrors?.length) {
        throw new Error(formatMutationUserErrors(payload.userErrors));
      }

      return payload.inventoryAdjustmentGroup || null;
    }
  };
}

module.exports = {
  createShopifyClient,
  buildProductSelection,
  mergePaginatedConnection
};
