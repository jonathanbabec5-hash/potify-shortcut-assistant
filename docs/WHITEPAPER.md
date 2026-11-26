# POTIFY Shortcut Studio: Technical Whitepaper

## Abstract

Shortcut Studio is a web companion for constructing iOS Shortcuts with a review step between a natural-language request and an exported file. Its design combines deterministic planning and catalog/schema checks with optional language-model assistance. The intended safety property is to ask or decline when required details or supported actions are missing, rather than silently inventing them.

## System boundary

The public edition contains three main layers:

1. **Studio UI** (`artifacts/shortcuts-assistant`): a React progressive web app for describing, building, inspecting, validating, and downloading workflows.
2. **API server** (`artifacts/api-server`): an Express service for planning, generation, validation, repair, and learning/evaluation endpoints.
3. **Shared packages** (`lib/*`): typed API contracts and clients, database schema, provider integration, and the static Shortcuts action catalog.

The workspace also includes `artifacts/mockup-sandbox`, a separate design artifact. It is not the primary product UI.

## Generation and validation flow

A request is transformed into a structured plan before model refinement. The planner and catalog constrain action selection; schema and completion checks inspect identifiers, required parameters, control-flow structure, and compatibility data. The UI distinguishes deterministic compatibility findings from probabilistic model observations. Repair can attempt to preserve the requested intent while correcting a detected defect. Export serializes the accepted workflow as a Shortcut-compatible property-list payload.

The intended control points are:

- **Clarify missing inputs:** recipient, message body, or other required values are not filled with invented private details.
- **Refuse unsupported capabilities:** an action absent from the catalog is not represented as an importable no-op.
- **Inspect before export:** the plan and diagnostics are visible before the user downloads a file.
- **Test on-device:** schema recognition cannot guarantee the action will work on every iOS version or account configuration.

## Data and privacy boundaries

The UI documentation says generated Shortcut data is held in memory for a short download window and is not persisted long-term. The repository also contains a separate learning/evaluation subsystem and a database package; a running instance may persist learning or governance data when configured. Do not treat the UI statement as a guarantee about every deployment: inspect the routes, consent settings, database, retention job, logs, and provider configuration before operating a shared service.

AI-backed requests are sent to whichever provider is configured for the API server. A local typecheck or build does not send prompts or use a provider. Never commit API keys, database URLs, subject salts, user payloads, exported Shortcut files, or diagnostic media.

## Reproducible developer workflow

The repository includes its pnpm workspace, leaf package manifests, and lockfile. The reviewed offline build was:

```sh
pnpm install --frozen-lockfile
PORT=5173 BASE_PATH=/ pnpm -w run build
```

The command completed typechecking and builds for the workspace. No database-backed tests or model-provider tests were run as part of the release review. Before running the full API test suite, inspect which tests need a database or provider and use disposable local services only.

## Evaluation model

The source includes synthetic regression and privacy tests. Regression cases assess both successful construction and safe refusal/clarification; privacy tests exercise redaction with deliberately synthetic values. These tests are not production data. This release review verified a clean workspace build, not runtime behavior on iOS hardware or live provider/database behavior.

## Limitations

The action catalog and property-list understanding rely on community-maintained references. The About screen says compatibility data is manually maintained and may lag platform changes. Model-based findings are probabilistic. Neither generated workflows nor validation results are endorsed by Apple. Review every action, permissions prompt, recipient, and device requirement before importing or running an export.

## Future pilot questions

A focused pilot should measure whether developers can reproduce the build, whether the validation layer catches unsupported or incomplete requests, and whether consultants can use the inspection flow in client work. The proposed target metrics and outreach plan are in [PILOT-MARKETING.md](PILOT-MARKETING.md).
