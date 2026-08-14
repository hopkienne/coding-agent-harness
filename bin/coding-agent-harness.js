#!/usr/bin/env node
import { main } from "../src/index.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(`coding-agent-harness: ${error.message}`);
  process.exitCode = 1;
});
