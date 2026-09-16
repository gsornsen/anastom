#!/usr/bin/env node
import { writeFileSync } from "node:fs";

setTimeout(() => writeFileSync("late-write-marker", "PRIVATE_SENTINEL"), 750);
