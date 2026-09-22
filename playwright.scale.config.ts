import { defineConfig } from "@playwright/test";

// Transfers near the 2 GB limit, across browser engines. Slow and disk-hungry,
// so they run on demand (`npm run test:scale`), never in CI.
export const SCALE_PORT = 8092;

export default defineConfig({
  testDir: "tests/scale",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: "list",
  webServer: {
    command: "npm run build && node server/main.ts",
    url: `http://localhost:${SCALE_PORT}/healthz`,
    // Public STUN, as in production: WebKit, like Safari, hides its local
    // addresses and only connects once it has learned its public one.
    env: { PORT: String(SCALE_PORT) },
    reuseExistingServer: true,
  },
});
