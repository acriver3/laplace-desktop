# Laplace logo

`logo.svg` is the single editable source for the overlapping squares. The right square rises to suggest progress; their rectangular intersection represents connection. The symbol has no wordmark or background. The geometry matches the approved ascending-square concept.

To change the logo, replace `logo.svg` and run `pnpm brand:generate` from the repository root. Keep its square viewBox and use paths (convert circles, text and other shapes to paths in your vector editor). Use `currentColor` for theme-aware artwork. Commit the source and regenerated files together. Run `pnpm brand:check` to detect stale copies.

The generator updates the shared React artwork, Connect/marketing/docs/Builder favicons, black and white transparent SVG/PNG exports, the plugin package icons, and the design-system preview. Desktop builds derive PNG, ICO and ICNS resources from the generated `app-icon.svg`. Plugin and desktop app icons use a white rounded background so the black squares remain visible on arbitrary host surfaces.

Use `LogoMark` from `@repo/ui/components/logo` in workspace React applications. It inherits the surrounding text color; `Logo` adds an optional accessible text label. Builder and the design kit consume the same generated geometry. Do not paste logo paths into application components or edit generated exports.

Deploy the affected applications after committing changes. Rebuild/reinstall desktop and plugin packages to refresh their bundled icons. Already installed ChatGPT remote apps and external account/profile artwork may need their icon uploaded separately; use `plugins/laplace/assets/logo.png` for those hosts. Provider and customer logos are separate identities.
