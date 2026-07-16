const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProductSelection,
  mergePaginatedConnection
} = require('../src/shopifyClient');

test('buildProductSelection can include nested pageInfo for pagination', () => {
  const selection = buildProductSelection({ includeConnectionPageInfo: true });

  assert.match(selection, /images\(first: 250\)/);
  assert.match(selection, /variants\(first: 250\)/);
  assert.match(selection, /pageInfo\s*{\s*hasNextPage\s*endCursor\s*}/);
});

test('mergePaginatedConnection appends edges and updates pageInfo', () => {
  const merged = mergePaginatedConnection(
    {
      edges: [{ node: { id: 'v1' } }, { node: { id: 'v2' } }],
      pageInfo: {
        hasNextPage: true,
        endCursor: 'cursor-1'
      }
    },
    {
      edges: [{ node: { id: 'v3' } }],
      pageInfo: {
        hasNextPage: false,
        endCursor: 'cursor-2'
      }
    }
  );

  assert.deepEqual(merged.edges.map(({ node }) => node.id), ['v1', 'v2', 'v3']);
  assert.deepEqual(merged.pageInfo, {
    hasNextPage: false,
    endCursor: 'cursor-2'
  });
});
