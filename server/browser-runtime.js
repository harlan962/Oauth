import { fileURLToPath } from "node:url";

// A project-owned installation, never a user's Edge/Chrome or shared profile.
export const browserDirectory = fileURLToPath(
  new URL("../.local-browsers/", import.meta.url),
);
process.env.PLAYWRIGHT_BROWSERS_PATH = browserDirectory;
export const { chromium } = await import("playwright-core");
