#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so users can `npx geo-loop` without a build step.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
const { register } = await import("tsx/esm/api");
register();
await import("../src/cli.ts");
