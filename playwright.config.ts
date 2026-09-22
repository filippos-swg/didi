import { defineConfig, devices } from "@playwright/test";

// Two servers. Chromium tests use one without STUN, so they never depend on the
// internet: two browsers on one machine connect over their local addresses.
// WebKit, like Safari, hides its local addresses and only connects once it has
// learned its public one, so its tests use a server that hands out public STUN.
const OFFLINE_PORT = 8090;
const STUN_PORT = 8091;

// Playwright's Firefox gathers no ICE candidates at all (checked on macOS, with
// and without headless, and with every relevant preference), so it cannot be
// tested here. Real Firefox works; it is tested by hand. See docs/ARCHITECTURE.md.

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /cross-browser/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${OFFLINE_PORT}`,
        // Chrome hides local addresses behind mDNS names by default, which CI containers can't resolve.
        launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
      },
    },
    {
      name: "webkit",
      testIgnore: [/cross-browser/, /disk\.spec/], // saving to disk is Chrome and Edge only
      use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${STUN_PORT}` },
      // WebKit waits to learn its public address from internet STUN servers, which
      // is occasionally slow. A retry is reported as "flaky", so it stays visible.
      timeout: 120_000,
      retries: 1,
    },
    {
      name: "cross-browser",
      testMatch: /cross-browser/,
      use: { baseURL: `http://localhost:${STUN_PORT}` },
    },
  ],
  webServer: [
    {
      command: "npm run build && node server/main.ts",
      url: `http://localhost:${OFFLINE_PORT}/healthz`,
      env: { PORT: String(OFFLINE_PORT), DIDI_ICE_SERVERS: "[]" },
      reuseExistingServer: process.env.CI === undefined,
    },
    {
      // Serves the build the first command makes; pages are only requested once both are up.
      command: "node server/main.ts",
      url: `http://localhost:${STUN_PORT}/healthz`,
      env: { PORT: String(STUN_PORT) },
      reuseExistingServer: process.env.CI === undefined,
    },
  ],
});
