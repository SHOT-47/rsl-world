# T-08-module-dependency-integrity

## Objective

Parse every module’s `metadata.rsl-requires` string as comma-separated module IDs. Pass when each referenced module directory and SKILL.md exists and no dependency refers to an undefined module.

## Result format

Record `PASS` or `FAIL`, commands/fixtures used, observed output, and any skipped check with its reason. Do not convert a skipped test into a pass.
