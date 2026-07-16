const axios = require('axios');

const API_URL = 'https://apps.metroswimshop.com/uss_products_sync_app/cron_product_sync.php?limit=100';
const POLL_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 60000;

function logCycle(message) {
  console.log(`${new Date().toISOString()} - ${message}`);
}

async function callApi() {
  const response = await axios.get(API_URL, {
    responseType: 'text',
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true
  });

  const body = String(response.data || '').trim();
  logCycle(`HTTP ${response.status} ${response.statusText} - Response length ${body.length}`);
  logCycle(`Response body: ${body}`);
  return { statusCode: response.status, body };
}

function isCompleted(body) {
  const text = String(body).toLowerCase();
  return text.includes('completed');
}

function isSuccess(body) {
  const text = String(body).toLowerCase();
  return text.includes('success') || text.includes('successful');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  logCycle('Script started');

  while (true) {
    logCycle('Cycle started');
    let result;

    try {
      result = await callApi();
    } catch (error) {
      logCycle(`Request failed: ${error.message || error}`);
      logCycle(`Cycle ended with error. Waiting ${POLL_DELAY_MS}ms before retry.`);
      await sleep(POLL_DELAY_MS);
      continue;
    }

    if (result.statusCode !== 200) {
      logCycle(`Non-200 status received: ${result.statusCode}. Waiting ${POLL_DELAY_MS}ms before retry.`);
      logCycle('Cycle ended with non-200 status.');
      await sleep(POLL_DELAY_MS);
      continue;
    }

    if (isCompleted(result.body)) {
      logCycle('Received completed response. Stopping script.');
      logCycle('Cycle ended with completed response.');
      process.exit(0);
    }

    if (isSuccess(result.body)) {
      logCycle('Received success response. Retrying after delay...');
      logCycle('Cycle ended with success response.');
      await sleep(POLL_DELAY_MS);
      continue;
    }

    logCycle('Unexpected response body. Waiting to retry.');
    logCycle('Cycle ended with unexpected response.');
    await sleep(POLL_DELAY_MS);
  }
}

main().catch((error) => {
  console.error('Script failed:', error.message || error);
  process.exit(1);
});
