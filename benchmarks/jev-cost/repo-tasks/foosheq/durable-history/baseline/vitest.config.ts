import { defineConfig } from "vitest/config";
export default defineConfig({ cacheDir: ".test-cache", test: { environment: "node", fsModuleCachePath: ".test-cache/fs", pool: "forks", maxWorkers: 1, fileParallelism: false } });
