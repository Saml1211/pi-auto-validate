# pi-auto-validate

Deterministic post-tool syntax validation hook and TypeSafe Jev risk guard for the **Pi Coding Agent**, inspired by Dan Disler's ([IndyDevDan](https://github.com/disler)) *I'm HOOKED on Claude Code Hooks*.

## The Problem

Agents operate probabilistically. When writing or editing code via `edit` or `write`, agents frequently produce subtle syntax errors:
- Missing closing parentheses, brackets, or semicolons in TS/JS
- Indentation and unclosed statement errors in Python
- Unclosed conditionals in Shell scripts
- Malformed JSON commas or trailing characters

Without deterministic hooks, the agent assumes the file was updated cleanly and wastes multiple turns debugging mysterious errors downstream.

## The Solution

`pi-auto-validate` intercepts the `tool_result` event immediately after `edit` or `write`:
1. **Sub-20ms Deterministic Checks**:
   - `.json`: `JSON.parse`
   - `.ts`, `.tsx`, `.js`, `.jsx`: `bun build --no-bundle`
   - `.py`: `python3 -m py_compile`
   - `.sh`, `.bash`: `bash -n`
2. **Immediate Turn-1 Self-Repair**: Injects syntax errors directly into the tool result before the next turn begins.
3. **TypeSafe Jev Critical File Audit**: Runs a calibrated risk check whenever sensitive files (`settings.json`, `auth.json`, `AGENTS.md`, `.env`) are edited.

## Verification

```bash
node --input-type=module test.ts
```
