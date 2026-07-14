import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "y-comments-prosemirror",
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
