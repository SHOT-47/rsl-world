# T-03-sequential-fallback

## Objective

Run the workflow with subagents and parallel execution unavailable. Pass when required gates complete sequentially or emit a specific capability blocker, with fallback state recorded.

## Result format

Record `PASS` or `FAIL`, commands/fixtures used, observed output, and any skipped check with its reason. Do not convert a skipped test into a pass.
