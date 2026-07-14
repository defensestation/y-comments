import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "y-comments-core",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
