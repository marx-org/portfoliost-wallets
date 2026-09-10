import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    pool: "forks",
    forks: {
      singleFork: true,
    },
    exclude: ["dist/**", "node_modules/**"],
  },
})
