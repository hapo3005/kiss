const input = process.argv[2];
if (!input) {
  console.error('Usage: node wait-for-url.mjs <url>');
  process.exit(2);
}

const timeoutMs = Number(process.env.KISS_QA_WAIT_TIMEOUT || 120000);
const started = Date.now();
const candidates = [...new Set([input, input.endsWith('/') ? input : `${input}/`])];
let lastError = '';

while (Date.now() - started < timeoutMs) {
  for (const target of candidates) {
    try {
      const response = await fetch(target, { redirect: 'follow' });
      if (response.status >= 200 && response.status < 400) {
        console.log(`Preview ready: ${target} (${response.status})`);
        process.exit(0);
      }
      lastError = `${target}: HTTP ${response.status}`;
    } catch (error) {
      lastError = `${target}: ${error.message}`;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.error(`Preview did not become ready within ${timeoutMs}ms. Last error: ${lastError}`);
process.exit(1);
