# Security Policy

## Reporting a vulnerability

Open a **private** report through GitHub's [Security → Report a vulnerability](https://github.com/orangca/dsh-plugin-memory/security/advisories/new)
form, or open a regular issue if the finding is not sensitive. Please include the plugin version, your DSH build, and
a minimal reproduction.

## Scope and threat model

This plugin stores text the user (or the agent) asked it to remember and injects parts of it back into the model's
context. That makes **what gets stored** and **how it is rendered** security-relevant.

What the implementation guarantees today:

| Area | Guarantee |
|---|---|
| Hard secrets | API keys, private keys, passwords, national IDs and bank cards are **rejected at write time**, with no force flag. Detection folds full-width/compatibility forms (NFKC) before matching, so `１２３…` cannot slip past the half-width patterns. |
| PII | Email addresses and phone numbers are **masked before storage** (`piiPolicy: mask`), or rejected (`reject`). |
| Injection structure | Every injected line is flattened to a **single line** and stripped of control, zero-width and bidi characters, so stored text cannot forge block headers, footers or extra `[system]` lines. |
| Rendering | Memory blocks are always emitted with an explicit header and a footer stating that the block is historical data, not instructions, and that the current conversation wins on conflict. |
| Provenance | Write origin is decided by the plugin from real user messages; the model cannot claim "the user asked for this". Model self-observations need recurrence across ≥2 sessions before they reach the system-prompt channel. |
| Data location | Everything stays under `$DSH_HOME/storages/<domainName>/`. No network calls, no telemetry, no embedding service. |

Known limits you should factor into your own risk assessment:

- A memory whose **text** contains imperative-looking prose but no forbidden payload is stored and injected verbatim
  (only line structure is sanitized). Treat remembered content with the same suspicion as any other context.
- `/memory import` validates fields and downgrades imported rows to `origin: observed`, but it reads a path you give
  it — only import files you trust.
- `reportPath` (development only) writes a JSON self-report containing counters and short previews; do not enable it
  in a shared environment.

## Supported versions

The latest released minor line (`0.5.x`) receives fixes. Version numbers advance by one patch (`0.5.0 → 0.5.1`).
