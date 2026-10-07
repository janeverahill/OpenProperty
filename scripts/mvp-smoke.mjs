import { spawn } from "node:child_process";

const child = spawn("pnpm", ["exec", "wrangler", "dev", "--port", "8787"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:8787${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function waitForServer() {
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    try {
      return await getJson("/api/operations/self-check");
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError ?? new Error("Wrangler did not start");
}

try {
  const selfCheck = await waitForServer();
  if (!selfCheck.passed) {
    throw new Error(`Operations self-check failed: ${JSON.stringify(selfCheck)}`);
  }

  const dashboard = await getJson("/api/dashboard/summary");
  if (!(dashboard.properties >= 3 && dashboard.units >= 6 && dashboard.active_leases >= 5)) {
    throw new Error(`Demo portfolio did not seed correctly: ${JSON.stringify(dashboard)}`);
  }

  const reconciliations = await getJson("/api/payment-reconciliations");
  const types = new Set((reconciliations.payment_reconciliations ?? []).map((item) => item.match_type));
  for (const expected of ["exact", "short", "late"]) {
    if (!types.has(expected)) throw new Error(`Missing demo reconciliation scenario: ${expected}`);
  }

  console.log(`MVP smoke test passed: ${selfCheck.passed_count}/${selfCheck.total} rule checks, ${dashboard.properties} properties, ${dashboard.units} units.`);
} catch (error) {
  console.error(output);
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await sleep(250);
  if (!child.killed) child.kill("SIGKILL");
}
