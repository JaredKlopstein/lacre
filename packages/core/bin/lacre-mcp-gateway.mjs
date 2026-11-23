#!/usr/bin/env node
import { runMcpGatewayCli } from '../dist/gateway/stdio.js';
process.exit(await runMcpGatewayCli(process.argv.slice(2)));
