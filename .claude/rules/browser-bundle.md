---
paths:
  - "src/web/**/*.tsx"
  - "src/web/model.ts"
  - "src/web/animation.ts"
  - "src/web/index.html"
  - "src/domain.ts"
  - "src/categories.ts"
  - "src/plan.ts"
---

# Browser bundle boundary

`src/web/` is served with Bun HTML imports and React DOM.

## JSX pragma

Browser TSX files must start with this pragma, because the root `tsconfig.json` sets the JSX source to `@opentui/react` for the terminal UI:

```tsx
/** @jsxImportSource react */
```

## What the browser may import

- Server types only with `import type`. Never import mail services, filesystem APIs, varlock, or credentials. Such an import would ship server code in the bundle and break `--web --demo`, which must stay credential-free.
- Browser-safe schema modules are allowed: `src/domain.ts`, `src/categories.ts`, `src/plan.ts` and `src/web/model.ts`. Keep them free of server imports. Decode every API response and stream event with them instead of hand-written guards:

  ```ts
  return Schema.decodeUnknownSync(schema)(await response.json());
  ```

## Components

Components stay plain React, with no Effect runtime. The Effect rules for server code are in [effect.md](effect.md).

## CSS variables

CSS custom properties are typed in `src/web/css-variables.d.ts`. Extend that file instead of casting `style` objects.
