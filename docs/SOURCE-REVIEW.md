# Source Review and Release Boundary

## Provenance

This developer edition uses the reviewed Replit `main` source tree at `f3cb6f3acbee0dc25721f0f210579ecad7dec8ef`. The `replit-agent` tip was `43221e31efc830fd17598ad8efb99a00b41b1d7d`; the two source branches had identical trees at review time. The public repository is a point-in-time source snapshot, not a copy of the Replit commit history.

The project owner verified the Shortcut Studio project's ownership and approved source backup and public build sharing. The review found no collaborator-authored commits in the visible 25-commit history.

## Included and excluded

The source portion contains 382 tracked text files. Nine release documentation/example files bring the public repository total to 391 files.

Excluded from the source snapshot:

- 21 files under private `.agents/` memory.
- 9 screenshot images under `screenshots/`.
- `.replit`, `.replitignore`, `replit.md`, and 3 `.replit-artifact` registration files.
- `docs/research-synthesis.md`, an internal research/planning document.

No `.shortcut` or `.plist` files were present in the tracked source. No binary files are included in the source portion. Test-only privacy fixtures use deliberately synthetic examples; they are not personal Shortcut records or live credentials.

## Asset and licensing findings

Google Fonts are loaded remotely (Cormorant Garamond, Inter, JetBrains Mono). The app-owned vector favicon remains. Community research sources are credited in the About page and `docs/THIRD-PARTY-NOTICES.md`; no third-party photos or screenshots are published. The root package manifest says MIT, but the source had no top-level license file; this edition adds no license text.

## Verification

The isolated source working copy passed `PORT=5173 BASE_PATH=/ pnpm -w run build` with Node 24.22.3 and pnpm 10.26.1. This typechecked and built the workspaces. Database-backed and model-provider tests were not run; no credentials were used.

The original Replit project, production deployment, payments, Replit plans, and social accounts were not changed.
