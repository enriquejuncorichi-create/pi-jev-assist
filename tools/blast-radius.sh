#!/usr/bin/env bash
# blast-radius — every caller of every symbol this change touches.
#
# Why this exists, from measurement rather than taste. Across 1,252 inline
# review findings on 131 pull requests (23 Aug – 17 Sep 2026), the single
# largest class of BLOCKING findings is a broken or unconsidered caller: 13 of
# 108 blockers (12%), ahead of guards failing open (10.2%). `AGENTS.md` already
# names it by hand — "enumerate callers of every function you change, and check
# each one, before claiming a blast radius is clear" — and this does the
# enumeration so the claim can be checked rather than asserted.
#
# It is DELIBERATELY mechanical: grep over the working tree, no model, no
# probability. A caller either appears or it does not.
#
# It NEVER truncates a list it draws a conclusion from. Where a cap applies it
# prints what was dropped, because a shortened enumeration reads as "all clear"
# when it is not — that is a named failure mode in this repo's rules.
#
# Usage, from the repo root:
#   bun run blast-radius                 # vs origin/main
#   bun run blast-radius origin/main     # explicit base
#
# Exit codes: 0 always when it ran (this is a checklist, not a verdict), 2 on a
# usage or setup error. It reports; you check.
set -uo pipefail

# Two ways in, one enumeration.
#
#   AFTER  (diff-seeded)   what did I just change, and who calls it?
#   BEFORE (--symbol/--file) what depends on this, before I touch it?
#
# The before-mode is the cheaper half. "You did not consider this caller" is a
# PLANNING failure, and answering it after the code is written only tells you
# what you have already broken.
MODE="diff"
SEED=""
BASE="origin/main"
while (( $# )); do
  case "$1" in
    # `shift 2 || true` HANGS when the flag is last: shift fails, the guard
    # swallows it, and the loop never advances. Require the value instead.
    --symbol|--file)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "$1 needs a value" >&2; exit 2; }
      MODE="${1#--}"; SEED="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
blast-radius — every caller of every symbol in scope.

  blast-radius [base-ref]          after: seeded from the diff vs base (default origin/main)
  blast-radius --symbol NAME       before: what depends on this symbol
  blast-radius --file PATH         before: what depends on this file's exports
USAGE
      exit 0 ;;
    *) BASE="$1"; shift ;;
  esac
done

git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 2; }
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT" || exit 2
command -v rg >/dev/null || { echo "ripgrep (rg) is required" >&2; exit 2; }

if [[ "$MODE" == "diff" ]]; then
  BASE_SHA=$(git merge-base HEAD "$BASE" 2>/dev/null) || {
    echo "cannot resolve merge-base with $BASE" >&2; exit 2; }
  mapfile -t FILES < <(git diff --name-only "$BASE_SHA"...HEAD -- \
    | grep -E '\.(ts|tsx|js|jsx|svelte)$' \
    | grep -vE '(\.test\.|\.spec\.|__tests__/)' || true)
  if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "no changed TypeScript/Svelte production files vs $BASE — nothing to trace"
    exit 0
  fi
  echo "▸ blast radius of ${#FILES[@]} changed file(s) vs $BASE"
else
  [[ -z "$SEED" ]] && { echo "--$MODE needs a value" >&2; exit 2; }
  if [[ "$MODE" == "file" ]]; then
    [[ -f "$SEED" ]] || { echo "no such file: $SEED" >&2; exit 2; }
    FILES=("$SEED")
    echo "▸ blast radius of $SEED — BEFORE any change"
  else
    # Locate the declaring file so the symbol's own definition is not counted as
    # a caller, and so the search can be self-checked against it.
    decl=$(rg -l --glob '!**/node_modules/**' --glob '!**/dist/**' \
      -e "(export[[:space:]]+(async[[:space:]]+)?(function|const|class|interface|type)[[:space:]]+${SEED}\b)|(^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+${SEED}\b)" . \
      2>/dev/null | sed 's#^\./##' | head -1)
    # The `./` prefix must go: it is compared against `--glob "!$file"` to keep a
    # symbol's own declaration out of its caller list, and `./x` never matches `x`,
    # so the declaring file counted itself as a caller.
    if [[ -z "$decl" ]]; then
      echo "no declaration found for '$SEED' — refusing to report a blast radius" >&2
      echo "  A zero from a symbol that does not exist is not the same as no callers." >&2
      exit 2
    fi
    FILES=("$decl")
    ONLY_SYMBOL="$SEED"
    echo "▸ blast radius of '$SEED' (declared in $decl) — BEFORE any change"
  fi
fi
echo "  Mechanical enumeration. Every caller listed is one you must check."
echo

# Symbols whose DEFINITION LINE the change touched. A symbol whose body changed
# is what breaks callers; a symbol merely mentioned nearby is noise.
collect_symbols() {
  local file="$1"
  # Before-mode has no diff: take the file's declared symbols as they stand, or
  # just the one symbol that was asked about.
  if [[ -n "${ONLY_SYMBOL:-}" ]]; then printf '%s\n' "$ONLY_SYMBOL"; return; fi
  if [[ "$MODE" != "diff" ]]; then
    grep -oE '(export[[:space:]]+(async[[:space:]]+)?(function|const|class|interface|type)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*)' "$file" \
      | grep -oE '[A-Za-z_][A-Za-z0-9_]*$' | sort -u
    return
  fi
  git diff -U0 "$BASE_SHA"...HEAD -- "$file" \
    | grep -E '^\+' \
    | grep -vE '^\+\+\+' \
    | grep -oE '(export[[:space:]]+(async[[:space:]]+)?(function|const|class|interface|type)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*)|(^\+[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+[A-Za-z_][A-Za-z0-9_]*)' \
    | grep -oE '[A-Za-z_][A-Za-z0-9_]*$' \
    | sort -u
}

total_callers=0
undefined_symbols=0

for file in "${FILES[@]}"; do
  mapfile -t SYMS < <(collect_symbols "$file")
  echo "══ $file"
  if [[ ${#SYMS[@]} -eq 0 ]]; then
    echo "   no changed exported/declared symbol detected."
    echo "   NOT the same as 'no blast radius': an edit inside an existing"
    echo "   function body changes behaviour without changing its signature."
    echo "   Check this file's own callers by hand."
    undefined_symbols=$((undefined_symbols + 1))
    echo
    continue
  fi
  for sym in "${SYMS[@]}"; do
    # Word-boundary search across the tree, excluding the defining file itself.
    # `-e PATTERN` with every --glob BEFORE it. Writing `-- "$sym" --glob ...`
    # makes rg read the globs as FILENAMES: every search then errors and returns
    # nothing, and this script printed "no references outside its own file" for a
    # symbol with 23 of them. A silent zero is the false all-clear this tool
    # exists to prevent, so the search is verified below rather than trusted.
    # The trailing `.` is load-bearing. With NO path argument and a stdin that
    # is not a TTY, ripgrep searches STDIN instead of the working directory —
    # so every call from a script, a test or an extension returned zero hits
    # while the same command by hand returned dozens. A silent zero is the false
    # all-clear this tool exists to refuse, and it shipped inside the tool
    # itself: a whole repository scan reported "no references" for 192 symbols.
    mapfile -t HITS < <(rg -n --no-heading --word-regexp \
      --glob '!**/node_modules/**' --glob '!**/.next/**' --glob '!**/dist/**' \
      --glob '!**/build/**' --glob "!$file" -e "$sym" . \
      2>/dev/null | sed 's#^\./##' || true)
    count=${#HITS[@]}
    total_callers=$((total_callers + count))
    if (( count == 0 )); then
      # SELF-CHECK. The symbol is declared in $file, so it MUST be findable
      # there. If it is not, the search itself failed and a zero means nothing.
      # Reporting "no callers" from a broken search is a false all-clear, and
      # that is precisely the defect this tool is meant to catch in others.
      if ! rg -q --word-regexp -e "$sym" -- "$file" 2>/dev/null; then
        echo "   ✗ $sym — SEARCH FAILED (not even found in its own file)" >&2
        echo "       Refusing to report a blast radius from a search that did not run." >&2
        exit 2
      fi
      echo "   ● $sym — no references outside its own file"
      echo "       Either genuinely internal, or reached dynamically (string key,"
      echo "       barrel re-export, route convention). Confirm which."
      continue
    fi
    # Split into workspaces so cross-package reach is visible at a glance.
    echo "   ● $sym — $count reference(s):"
    printf '%s\n' "${HITS[@]}" | awk -F: '{print $1}' | sed -E 's#^(apps|packages|services)/([^/]+)/.*#\1/\2#; t; s#/.*##' \
      | sort | uniq -c | sort -rn | while read -r n ws; do
        printf '       %4d in %s\n' "$n" "$ws"
      done
    # The full list, never truncated, because the conclusion depends on it.
    printf '%s\n' "${HITS[@]}" | sed 's/^/         /'
  done
  echo
done

echo "──────────────────────────────────────────────"
echo "$total_callers reference(s) across ${#FILES[@]} changed file(s)."
(( undefined_symbols > 0 )) && echo \
  "$undefined_symbols file(s) had no detectable changed symbol — check those by hand."
cat <<'MSG'

This is a CHECKLIST, not a verdict. Three things it cannot see, each of which
has hidden a real caller in this repo:

  - Dynamic reach: a symbol used via a string key, a barrel re-export, or a
    SvelteKit/Next route convention has no textual call site.
  - Behaviour changes inside an unchanged signature: the callers are unchanged
    textually and still break.
  - Runtime coupling: a queue name, a job id, a DB column, a BC field. Nothing
    here greps those.

"Every caller still works" is a claim about each line above, one at a time.
MSG
exit 0
