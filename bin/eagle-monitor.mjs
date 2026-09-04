#!/usr/bin/env node

import { runEagleMonitorCli } from "../src/eagle-monitor-cli.mjs"

process.exitCode = await runEagleMonitorCli({ argv: process.argv.slice(2) })
