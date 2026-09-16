#!/usr/bin/env node
import { writeFileSync } from "node:fs";

setTimeout(() => writeFileSync(process.argv[2], "PRIVATE_SENTINEL"), 750);
