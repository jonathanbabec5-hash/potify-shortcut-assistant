# Third-Party Notices and Asset Review

## Visual assets

The app loads these typefaces from Google Fonts at runtime: Cormorant Garamond, Inter, and JetBrains Mono. The font files are not bundled in this repository. The app's `favicon.svg` is retained as a project-owned vector mark. The reviewed source contained screenshots, but all screenshot files were excluded from this release. No third-party photos, screenshots, or other binary media are included.

## Community research credits

The app's About page credits community-maintained research used to inform its action catalog and property-list format understanding:

- [sebj / iOS-Shortcuts-Reference](https://github.com/sebj/iOS-Shortcuts-Reference)
- [Shortcuts file format notes by zachary7829](https://zachary7829.github.io/blog/shortcuts/fileformat)
- [joshfarrant / shortcuts-js](https://github.com/joshfarrant/shortcuts-js)
- [drewburchfield / shortcuts-toolkit](https://github.com/drewburchfield/shortcuts-toolkit)
- [RoutineHub](https://routinehub.co)

These links are acknowledgements and research references; this release does not vendor those projects or include their media assets. Please review their current upstream terms before copying or redistributing any material from them.

## Software dependencies

Direct dependencies and resolved versions are declared in the workspace and package manifests and `pnpm-lock.yaml`. They are installed from upstream package registries rather than vendored here. This repository does not include a generated per-package license audit; review the license files for the dependencies you redistribute.

## License field

The root `package.json` in the reviewed source declares `MIT`, but there was no top-level `LICENSE` file. This public edition preserves the source manifest and does not add a license file or grant additional rights. Confirm the intended scope of that field before reuse.
