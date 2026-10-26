#!/usr/bin/env bun
import { main } from "../src/cli/main.ts";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
