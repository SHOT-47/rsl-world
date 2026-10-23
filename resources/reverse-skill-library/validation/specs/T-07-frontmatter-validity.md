# T-07-frontmatter-validity

## Objective

Parse frontmatter from every module SKILL.md. Pass when each contains valid YAML, conformant Agent Skills name/description, and string-to-string metadata; module dependencies use string metadata.

## Result format

Record `PASS` or `FAIL`, commands/fixtures used, observed output, and any skipped check with its reason. Do not convert a skipped test into a pass.
