#!/bin/bash
# Runs when MacBook lid opens / system wakes.
# Time gate + debounce handled in backend/runPollCycle.js

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1

NODE_ENV=production node backend/runPollCycle.js
