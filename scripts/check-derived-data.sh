#!/bin/sh
# Fails when a file of the UN/EDIFACT directories, or a registry built from them, is tracked by Git.
#
# The UN/ECE licence forbids distributing a modified directory, so the repository must hold no
# directory file and no registry generated from one (ADR 7). The registry generator writes its output
# on the operator's machine; the only registries in Git are the schema and the hand-written example in
# contracts/registry. The partner overrides of contracts/overrides name data elements too, but are
# rules of a partner and carry no directory text. This runs on every pull request (see ci.yml) and
# can be run by hand.
set -eu

cd "$(dirname "$0")/.."

found=$(mktemp)
trap 'rm -f "$found"' EXIT

# 1. By name: the archive of a directory, its parts, its message files, its licence, a registry.
git ls-files | grep -E -i \
  -e '(^|/)d[0-9]{2}[a-c]\.zip$' \
  -e '(^|/)(ed|tr|id)(ed|cd|sd|md)(i[12])?\.(zip|[0-9]{2}[a-z])$' \
  -e '(^|/)(uncl|unsl)(-[12])?\.(zip|[0-9]{2}[a-z])$' \
  -e '_d\.[0-9]{2}[a-z]$' \
  -e '(^|/)licenagr\.txt$' \
  -e '\.registry\.json$' >>"$found" || true

# 2. By content, whatever the name: the licence and the title pages of the directory files.
# This script and its test name these phrases, so they are the only files left out.
git grep -I -l -i -F \
  -e 'Licence Agreement for the use of UN/EDIFACT' \
  -e 'UNITED NATIONS STANDARD MESSAGE' \
  -e 'UNITED NATIONS DIRECTORIES FOR ELECTRONIC DATA INTERCHANGE' \
  -- . ':(exclude)scripts/check-derived-data.sh' \
  ':(exclude)packages/registry/src/derived-data-guard.test.ts' >>"$found" || true

# 3. A registry built from UN/ECE files, or any registry outside the folder of the contract.
git grep -I -l -E '"kind" *: *"unece-directory"' -- '*.json' >>"$found" || true
git grep -I -l '"dataElements"' -- '*.json' ':(exclude)contracts/registry/*' \
  ':(exclude)contracts/overrides/*' >>"$found" || true

if [ -s "$found" ]; then
  {
    echo "UN/EDIFACT directory files and registries built from them must not be committed (ADR 7):"
    sort -u "$found" | sed 's/^/  /'
    echo "Remove them from Git (git rm --cached) and keep them on your machine. See docs/registry-generator.md."
  } >&2
  exit 1
fi
echo "No UN/EDIFACT directory file and no generated registry is tracked."
