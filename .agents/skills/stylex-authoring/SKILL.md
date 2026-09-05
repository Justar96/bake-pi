---
name: stylex-authoring
description: Author, refactor, and review StyleX styles in JavaScript or TypeScript React code. Use when creating stylex.create definitions, applying or merging styles, writing conditional or dynamic styles, pseudo-classes, media queries, themes, variables, constants, relational selectors, animations, view transitions, anchor positioning, or type-safe style props, and when correcting StyleX antipatterns.
---

# StyleX Authoring

Use `@stylexjs/stylex` APIs so styles remain statically analyzable, composable, and type-safe. Inspect the installed StyleX version and project conventions before introducing newer APIs.

## Core pattern

Define namespaces with `stylex.create({...})`, then apply them with `{...stylex.props(styles.namespace)}`. Prefer longhand CSS properties and single-value shorthands; lengths are pixels by default. Merge in precedence order: `stylex.props(base, variant, style)`. Conditional values may be `false`, `null`, or expressions; use `null` to unset a property.

```tsx
const styles = stylex.create({
  button: { padding: 16, backgroundColor: 'lightblue' },
  active: { backgroundColor: 'blue' },
});

<button {...stylex.props(styles.button, isActive && styles.active, style)} />
```

Accept caller styles with `StyleXStyles` or a constrained `StyleXStyles<{...}>`. Use `StyleXStylesWithout` to prohibit properties a component must own.

## Conditions and selectors

Nest pseudo-classes and at-rules inside a property value with a required `default` key. Use `:hover`, `:active`, `:focus-visible`, and `:disabled` as appropriate. Use `@media`, `@supports`, and `@container` the same way. Prefer JS structure over `:first-child`/`:nth-child`; prefer real HTML over `::before`/`::after` for accessibility and smaller CSS.

```tsx
const styles = stylex.create({
  panel: { padding: { default: 8, '@media (min-width: 768px)': 16 } },
  button: { color: { default: 'black', ':hover': 'blue' } },
});
```

For ancestor, descendant, and sibling state use `stylex.when.ancestor`, `descendant`, `anySibling`, `siblingBefore`, or `siblingAfter`, marking the observed element with `stylex.defaultMarker()` or `stylex.defineMarker()`.

## Tokens and themes

Use `stylex.defineConsts()` for static reusable values such as breakpoints, z-indexes, animations, or non-themed constants. Use `stylex.defineVars()` for values that need theming or runtime overrides. Put both in `.stylex.ts`/`.stylex.js` files as named exports only; do not add other exports or default exports. Create DOM-subtree overrides with `stylex.createTheme(vars, overrides)`.

Use `defineConsts` for shared media-query constants instead of repeating breakpoint strings. Import vars/consts into `stylex.create` definitions; do not import arbitrary JavaScript constants into StyleX declarations.

Apply a theme to a subtree with `stylex.props(theme)`; descendants resolve the themed variables. Type variable groups with `VarGroup<typeof vars>` when a component accepts a theme object:

```tsx
import type { VarGroup } from '@stylexjs/stylex';
import { colors } from './tokens.stylex';

function ThemeProvider({theme, children}: {
  theme: VarGroup<typeof colors>;
  children: React.ReactNode;
}) {
  return <div {...stylex.props(theme)}>{children}</div>;
}
```

## Advanced APIs

- Runtime values: define style functions, e.g. `bar: (width: number) => ({width})`.
- Compatibility fallbacks: use `stylex.firstThatWorks('grid', 'flex')`.
- Animation: define keyframes with `stylex.keyframes()` and reference them via `animationName`.
- React View Transitions: use `stylex.viewTransitionClass()` with `ViewTransition`.
- Anchor positioning: use `stylex.positionTry()` for `positionTryFallbacks`.

Confirm each API exists in the installed version before using it.

## Review checklist

Reject top-level pseudo-classes or media queries; they belong inside property values. Reject arbitrary imported values, simultaneous `className`/`style` props on an element that spreads `stylex.props()`, and theme/variable files with invalid exports. Check merge order, required `default` branches, accessible HTML, and type constraints. Run the project's formatter, typecheck, lint, and production build after changes.

Official references: https://stylexjs.com/docs/llm-resources and https://stylexjs.com/docs/api
