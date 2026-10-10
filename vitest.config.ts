import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    pool: "forks",
    forks: {
      singleFork: true,
    },
    // Each test file creates an isolated PGlite instance. Running files in
    // parallel in one fork intermittently stalls the shared native runtime.
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
  },
})
