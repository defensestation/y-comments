import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "y-comments-blocknote",
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    globals: false,
  },
});
