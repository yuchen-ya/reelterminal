import { defineConfig } from "vitest/config";

// Deliberately failing lifecycle probes, invoked only by the Node test below.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/native-test-scope.fixture.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
