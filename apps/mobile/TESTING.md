# Mobile Testing — Status and Known Blockers

**Date of last revision:** 2026-04-24
**Stack:** Expo SDK 53 · React Native 0.76 · React 18.3.1 · Jest 29 ·
`jest-expo` 53 · `@testing-library/react-native` 13.3.3

This file captures the current state of the mobile test suite, what we
tried on the RNTL / RN 0.76 compatibility front, and the tradeoffs that
shaped the two patterns you'll see across `apps/mobile/__tests__/`.

## Current state

- **38 tests across 18 suites, all green.**
- Two test patterns co-exist:
  - **"Client-wiring" pattern** (majority): `require()` the screen module,
    assert the default export is a function, then source-grep the file to
    verify critical wiring (e.g. `useAuth()` is called, `login(` appears
    in the handler body). See `__tests__/login.render.test.tsx`,
    `__tests__/home.render.test.tsx`, etc. These never mount the
    component.
  - **Real render+press pattern** (currently one screen —
    `__tests__/ai-triage.render.test.tsx`): uses
    `render()`, `fireEvent.changeText()`, `fireEvent.press()` against
    the `TouchableOpacity` send button wrapped in `act()`. Works
    cleanly on 13.3.3 with no `act()` warnings when the async flow is
    explicitly awaited.

## What we tried on the RNTL front

| Attempt | Outcome |
|---|---|
| RNTL 12.7 (initial baseline) | Host-component detection failed on RN 0.76 — `getByText` returned no matches for rendered `<Text>` |
| RNTL 13.1 / 13.2 | Same host-component issue; newer matchers but the core detector was unchanged |
| RNTL 13.3 + `moduleNameMapper` pinning `react` and `react-test-renderer` to the app-local copy | Fixed the React 18/19 duplication that the monorepo hoist was creating — matchers started working |
| `process.env.RNTL_SKIP_DEPS_CHECK=1` in `jest.setup.js` | Muted the startup "react vs react-test-renderer" version warning that RNTL emits because the monorepo hoists `react` to 19.x while `apps/mobile` still declares 18.3.1 |
| Migrate to `expo-testing-library` | Package doesn't exist in the npm registry (as of 2026-04-24). Expo's canonical story is still "use `@testing-library/react-native`" |
| Bump to RNTL 14 | Only `14.0.0-beta.1` exists on npm; no stable release. Skipped — we don't ship pre-releases as devDeps |

## Current `moduleNameMapper` workarounds

From `apps/mobile/package.json`:

```json
"moduleNameMapper": {
  "^react$": "<rootDir>/node_modules/react",
  "^react/(.*)$": "<rootDir>/node_modules/react/$1",
  "^react-test-renderer$": "<rootDir>/node_modules/react-test-renderer",
  "^react-test-renderer/(.*)$": "<rootDir>/node_modules/react-test-renderer/$1"
}
```

Without these, jest resolves `react` via the repo-root hoist (React 19.x)
while RN 0.76 itself pulls React 18.3.1, which produces
"invalid hook call" errors at render time. The mapper pins both
`react` and `react-test-renderer` to the mobile workspace's local copy.

## Known blockers for the "render everywhere" migration

1. **`Animated` side-effects inside `TouchableOpacity`.** Most screens use
   `TouchableOpacity`, which wraps an `Animated` opacity. On press, it
   schedules a `setState` inside an animation frame. If the test doesn't
   `await act(async () => { fireEvent.press(...) })`, RNTL flushes the
   synthetic press handler but the animation's follow-up setState lands
   outside `act()` and jest prints the well-known
   "not wrapped in act(...)" warning — sometimes promoting to a failure
   in CI.

   The triage test works around this by always wrapping presses and
   `changeText` in `act(async () => ...)` AND awaiting
   `findByText`/`findByPlaceholderText` before the next interaction so
   the animation queue drains. Every screen that wants the real-render
   pattern will need the same discipline.

2. **`KeyboardAvoidingView` + `ScrollView` + Jest JSDOM**. Some screens
   (notably `login.tsx`) nest the form inside `KeyboardAvoidingView >
   ScrollView`. Under jsdom the scroll measurement calls produce
   `NaN`s that RNTL's host-component matcher treats as non-renderable.
   Triage uses `KeyboardAvoidingView` directly over a `FlatList` and
   doesn't trip this.

3. **`@expo/vector-icons` `Ionicons` component**. Renders a
   `<Text>` glyph under the hood that triggers font-loading side
   effects in tests. Mitigated in `jest.setup.js` via `jest.mock("@expo/vector-icons", ...)` returning a null-renderer for `Ionicons`.
   All new render tests should rely on that mock.

## Upgrade path (when the time comes)

In priority order:

1. **Wait for RNTL 14 stable.** Per the 14.x beta changelog, 14 rewrites
   the host-component detector on top of React Native's public
   `ReactTestInstance` API instead of the internal Fiber walker — this
   is expected to eliminate the `moduleNameMapper` workarounds above.
   Track: https://github.com/callstack/react-native-testing-library/milestones
2. **Consider `expo-testing-library` if Expo ships one.** No package as of
   2026-04-24; Expo docs currently redirect to
   `@testing-library/react-native`. If Expo ships a thin wrapper that
   auto-configures jest for SDK 53+, adopt it.
3. **Wait for RN 0.77.** The New Architecture's `ViewConfig` changes in
   0.77 are expected to simplify host-component detection. Not required
   for our upgrade but would let us drop the Animated workaround.

## Recommendation for new tests

- For screens with a simple `TouchableOpacity` + `TextInput`: use the
  real render+press pattern; mirror the structure of
  `__tests__/ai-triage.render.test.tsx`.
- For screens involving `ScrollView` + complex navigation or
  dynamic lists that currently resist jsdom: stick with the client-wiring
  pattern. A failing render test is worse than a passing smoke — at least
  the smoke catches module-load regressions and wiring drift.
- Always include **at least one** client-wiring assertion that grep
  checks the source for the critical handler name — this is what caught
  two recent "accidentally deleted `await login()` call" regressions
  that rendering alone would have missed (the button still rendered,
  just did nothing).
