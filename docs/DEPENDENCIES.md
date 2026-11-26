# Dependency and Runtime Manifest

## Reproducible toolchain

- Node.js: verified with 24.22.3.
- pnpm: verified with 10.26.1; use the committed `pnpm-lock.yaml` and the workspace catalog in `pnpm-workspace.yaml`.
- The build/typecheck completed using already installed dependencies; this review did not install packages or call a model provider.

## Workspace packages

- `artifacts/shortcuts-assistant`: React/Vite PWA, UI component libraries, generated API client, and plist support.
- `artifacts/api-server`: Express API, OpenAI-compatible client, Drizzle ORM/PostgreSQL, and property-list generation.
- `artifacts/mockup-sandbox`: optional Vite design mockup; included in the root workspace build.
- `lib/api-client-react`, `lib/api-zod`, and `lib/api-spec`: typed contracts and API clients.
- `lib/db`: PostgreSQL connection and schema.
- `lib/integrations-openai-ai-*`: OpenAI-compatible provider integration packages.
- `scripts`: workspace checks and repository tooling.

The package manifests and lockfile are the authoritative dependency list. Key direct technologies include React, Vite, TypeScript, Tailwind CSS, Radix UI, Express, OpenAI SDK, Drizzle, PostgreSQL, Zod, and `bplist-creator`.

## Runtime configuration

Environment variable **names** referenced by source (never place values in Git):

- `PORT`: required by the API server and mockup build configuration; the main Vite app accepts it for local serving.
- `BASE_PATH`: optional for the main app (defaults to `/`); required by the mockup build.
- `DATABASE_URL`: PostgreSQL connection string, required by the API/database package at runtime.
- `OPENROUTER_API_KEY`: optional model provider credential; `OPENROUTER_BASE_URL` and `OPENROUTER_REASONING_MODEL` are optional settings.
- `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL`: optional Replit OpenAI-compatible provider configuration.
- `LEARNING_SUBJECT_SALT` or `SESSION_SECRET`: used by learning privacy/pseudonymization code when configured.

The verified build command sets only local non-secret build values:

```sh
PORT=5173 BASE_PATH=/ pnpm -w run build
```

No database migrations, schema pushes, model calls, or production configuration changes were performed during this review.
