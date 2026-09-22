import { defineConfig, devices } from "@playwright/test";

const PORT = 8090;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Two browser contexts on one machine connect over host candidates. Chrome
        // hides those behind mDNS names by default, which CI containers can't resolve.
        launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
      },
    },
  ],
  webServer: {
    command: "npm run build && node server/main.ts",
    url: `http://localhost:${PORT}/healthz`,
    // No STUN in tests: they must not depend on the network, and host candidates suffice locally.
    env: { PORT: String(PORT), DIDI_ICE_SERVERS: "[]" },
    reuseExistingServer: process.env.CI === undefined,
  },
});
