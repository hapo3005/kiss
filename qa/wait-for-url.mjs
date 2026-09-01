const target = process.argv[2];
if (!target) {
  console.error('Usage: node wait-for-url.mjs <url>');
  process.exit(2);
}

const timeoutMs = Number(process.env.KISS_QA_WAIT_TIMEOUT || 120000);
const started = Date.now();
let lastError = '';

while (Date.now() - started < timeoutMs) {
  try {
    const response = await fetch(target, { redirect: 'follow' });
    if (response.ok || (response.status >= 300 && response.status < 500)) {
      console.log(`Preview ready: ${target} (${response.status})`);
      process.exit(0);
    }
    lastError = `HTTP ${response.status}`;
  } catch (error) {
    lastError = error.message;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.error(`Preview did not become ready within ${timeoutMs}ms: ${target}. Last error: ${lastError}`);
process.exit(1);
