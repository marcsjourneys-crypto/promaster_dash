/**
 * Master switch for in-vehicle diagnostic tooling (address sweeps, DID probes).
 *
 * Driven by the build command, not by hand-editing a constant — a normal build
 * folds this to `false` at bundle time and the diagnostic buttons disappear, so
 * a TestFlight or App Store build cannot ship them by accident.
 *
 *   npm run ios:release   → diagnostics OFF  (what testers and the store get)
 *   npm run ios:diag      → diagnostics ON   (cable build to your own phone)
 *
 * EXPO_PUBLIC_* vars are inlined by Metro at bundle time, so changing this
 * requires a fresh bundle — a fast-refresh reload will not pick it up.
 */
export const DIAGNOSTICS_ENABLED = process.env.EXPO_PUBLIC_DIAGNOSTICS === '1';
