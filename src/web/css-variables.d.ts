import "react";

declare module "react" {
  /**
   * CSS custom properties (`--accent`, `--columns`, …) set through inline styles.
   */
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}
