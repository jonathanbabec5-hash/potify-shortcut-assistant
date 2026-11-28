# POTIFY Shortcut Assistant — developer edition

## Find your way in

| If you are… | Start here | Try this |
| --- | --- | --- |
| An iPhone shortcut maker | [See what is included](#what-is-included) | Explore the sanitized developer edition and action catalog. |
| A developer | [Build the workspace](#build) | Follow the documented local build requirements. |
| A reviewer | [Read the source boundary](docs/SOURCE-REVIEW.md) | See what the public edition includes and excludes. |

[Full repository tree](docs/DIRECTORY.md) · [Technical whitepaper](docs/WHITEPAPER.md) · [Developer and sales pilot](docs/PILOT-MARKETING.md)

POTIFY Shortcut Studio is a companion for designing, inspecting, validating, and exporting iOS Shortcuts. This repository is a public, sanitized developer edition of the owner-reviewed source; it is not a production deployment or an Apple product.

## What is included

- The actual React/Vite studio, Express API server, shared API packages, action catalog, tests, and the small design mockup workspace.
- A complete lockfile and workspace/package manifests.
- Synthetic example intents only. No exported personal Shortcuts or real shortcut payloads are included.
- A complete file inventory in [docs/DIRECTORY.md](docs/DIRECTORY.md).

The source snapshot excludes private agent notes, screenshots, Replit-only project/deployment settings, and internal research notes. See [docs/SOURCE-REVIEW.md](docs/SOURCE-REVIEW.md) for the exact review boundary.

## Build

Verified with Node 24.22.3 and pnpm 10.26.1:

```sh
pnpm install --frozen-lockfile
PORT=5173 BASE_PATH=/ pnpm -w run build
```

The workspace build typechecks and builds all packages, including the optional mockup sandbox. That mockup requires `PORT` and `BASE_PATH`; these values are local build settings only. The build does not require a database or model-provider credentials and does not make AI calls.

To run only the product packages after installing dependencies:

```sh
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/shortcuts-assistant build
```

## Local runtime notes

- The API server requires `PORT` and `DATABASE_URL` (PostgreSQL). The database package provides `pnpm --filter @workspace/db push`; use it only against a disposable/local development database after reviewing the schema changes. Never point setup commands at production.
- AI-backed generation requires a model provider configured through environment variables. The source supports `OPENROUTER_API_KEY` or the Replit OpenAI-compatible integration variables; optional provider settings are listed in `docs/DEPENDENCIES.md`. Put credentials in a secret manager or an untracked local environment file, never in Git.
- The UI uses Vite; `BASE_PATH` defaults to `/`, and `PORT` can be set for its dev server. The committed Vite config does not define a local API proxy. For end-to-end local use, route `/api` to the API server using your development setup.
- Generated Shortcut export is described in the app as short-lived in-memory data; the wider learning subsystem uses the configured database. Review privacy and retention settings before operating a shared instance.

For a local build, validation, and review workflow, see [docs/WHITEPAPER.md](docs/WHITEPAPER.md).

## Try a fictional workflow

Open [the synthetic intents](examples/synthetic-intents.json) and choose one routine. Compare its expected actions against the planner. The following checks run locally without an account, a database or a model provider after the workspace install.

```sh
pnpm --filter @workspace/api-server exec node --import=tsx --test \
  src/lib/shortcuts/planner.test.ts src/lib/shortcuts/dataflow.test.ts \
  src/lib/shortcuts/validation.test.ts
pnpm --filter @workspace/shortcuts-assistant test
```

Those commands exercise 44 planner, dataflow and validation checks and nine visual-builder logic checks. The broader API suite also exercises consent, retention and training with PostgreSQL. For a disposable database run, create a fresh local `LEARNING_SUBJECT_SALT` for that run so consent and withdrawal can find the same fictional subject. The provider smoke test in `model-config.test.ts` makes a network request. [Reproduction details](docs/SOURCE-REVIEW.md)

## Safe examples and release notes

The examples in `examples/synthetic-intents.json` are fictional prompts, not real user Shortcuts. Test generated exports on a device before relying on them. The catalog is community-informed and manually maintained; compatibility results are best-effort, not an Apple guarantee.

The source root manifest contains an MIT license field, but the reviewed source had no top-level `LICENSE` file. This edition adds no new license text; verify license scope and third-party terms before downstream reuse. See [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).
