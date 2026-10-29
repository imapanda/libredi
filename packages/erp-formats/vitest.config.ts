import { defineConfig } from "vitest/config";

// The tests with generated files and thousands of random cases take a second or less on a
// developer machine and several times that on a shared CI runner: 5 seconds, Vitest's default, is
// too close. A test that really hangs still fails, after 15.
export default defineConfig({
  test: { testTimeout: 15_000 },
});
