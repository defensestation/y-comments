import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      // measure the shipped sources only — not dist builds or the example app
      include: ["packages/*/src/**"],
    },
  },
});
