# MedCore Mobile

Patient + doctor-lite companion app for
[MedCore HMS](https://medcore.globusdemos.com).

- **Framework:** Expo SDK 53 + `expo-router` v4
- **Language:** TypeScript (React 19 / React Native 0.76)
- **Supported platforms:** iOS 15+, Android 8+ (API 26+), Web (dev preview only)

A new mobile engineer should be able to clone the repo, follow the Quick
Start below, and have a working simulator build in under 10 minutes.

---

## Quick Start

```bash
# From the monorepo root
cd apps/mobile
npm install

# Development (choose one)
npm run dev          # Expo dev server (opens Metro + QR for Expo Go)
npm run ios          # Launch iOS simulator (macOS only)
npm run android      # Launch Android emulator / connected device
npm run web          # Web preview (React Native for Web)

# Type-check + tests
npm run typecheck    # tsc --noEmit
npm test             # jest + @testing-library/react-native
```

### Running on Expo Go

1. Install **Expo Go** from the App Store / Play Store.
2. `npm run dev` and scan the QR code shown in the terminal.
3. The device must be on the same network as the dev machine, or use the
   `--tunnel` flag.

### Environment variables

Create `apps/mobile/.env` (git-ignored) or export inline:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.10:3001/api/v1
```

| Variable                | Required | Purpose                                          |
| ----------------------- | -------- | ------------------------------------------------ |
| `EXPO_PUBLIC_API_URL`   | No       | Base API URL; baked into JS bundle at build time |
| `EAS_PROJECT_ID`        | No (EAS) | Linked EAS project — used by `eas build`         |
| `GOOGLE_SERVICES_JSON`  | No (EAS) | Path to `google-services.json` for FCM on Android |

---

## Project structure

```
apps/mobile/
├── app/                          # expo-router file-based routes
│   ├── _layout.tsx               # auth guard + role-based router
│   ├── index.tsx                 # splash
│   ├── login.tsx
│   ├── register.tsx
│   ├── (tabs)/                   # PATIENT stack (5 tabs)
│   │   ├── _layout.tsx
│   │   ├── home.tsx              # dashboard + next appointment
│   │   ├── appointments.tsx      # book / cancel / history
│   │   ├── queue.tsx             # live OPD token tracking
│   │   ├── prescriptions.tsx     # download / QR verify
│   │   └── billing.tsx           # invoices + online payment
│   └── (doctor-tabs)/            # DOCTOR-LITE stack (4 tabs)
│       ├── _layout.tsx
│       ├── workspace.tsx         # today's queue + call next
│       ├── patients.tsx          # patient lookup
│       ├── prescriptions.tsx     # quick Rx composer
│       └── profile.tsx
├── lib/
│   ├── api.ts                    # fetch wrapper, 401 auto-refresh
│   ├── auth.tsx                  # AuthProvider / useAuth
│   ├── socket.ts                 # useQueueSocket (socket.io-client)
│   └── hooks/
│       └── usePushRegistration.ts
├── __tests__/
│   └── login.smoke.test.tsx      # single jest + RNTL smoke test
├── assets/                       # icon, splash, adaptive-icon, notification-icon
├── app.config.ts                 # dynamic Expo config (env-aware)
├── eas.json                      # development / preview / production profiles
└── package.json
```

---

## Features by role

### Patient (5 tabs)

1. **Home** — greeting, next appointment, quick links, unread notifications.
2. **Appointments** — book a slot with a doctor, cancel, view history.
3. **Queue** — live OPD token updates via socket.io (your number, position,
   ETA).
4. **Prescriptions** — list, PDF download, scan-to-verify QR.
5. **Billing** — invoice list, pay online via WebView checkout (Razorpay).

### Doctor-lite (4 tabs, MVP)

1. **Workspace** — today's OPD queue, call next patient.
2. **Patients** — search and open patient card.
3. **Prescriptions** — minimal Rx composer (medication + dosage).
4. **Profile** — logout, push-token refresh.

> Doctor-lite is intentionally minimal — the full doctor workflow lives on
> the web dashboard; this is a "doctor on rounds" subset.

---

## API connection

The base URL is resolved at runtime in `lib/api.ts`, in this order:

1. `EXPO_PUBLIC_API_URL` env var (build-time, baked into JS bundle).
2. `expoConfig.extra.apiUrl` — set in `app.config.ts`.
3. Hardcoded fallback: `https://medcore.globusdemos.com/api/v1`.

### Pointing at a local API

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.10:3001/api/v1 npm run dev
```

Use your machine's LAN IP — `localhost` from a device points at the device
itself. The same variable is honoured by all three EAS profiles
(`development`, `preview`, `production`) via `eas.json`.

### Token refresh

`lib/api.ts` wraps every request with a 401 interceptor that:

1. Calls `POST /auth/refresh` with the stored refresh token.
2. Persists the new pair in `expo-secure-store`.
3. Retries the original request once.
4. On refresh failure, clears tokens and logs the user out.

A single in-flight refresh promise is reused across concurrent requests to
avoid a thundering herd.

### Realtime queue

`lib/socket.ts` exposes `useQueueSocket(enabled, onEvent)`, used by the
patient Queue tab and the doctor Workspace. It connects to the API origin
(API URL minus `/api/v1`) using `socket.io-client` and listens for:

- `queue.update`
- `queue.advance`
- `queue.token.called`
- `appointment.status.update`

The hook lazy-loads the socket module so the bundle still builds when
offline.

---

## Testing

```bash
npm test                    # jest + @testing-library/react-native
npm test -- --watch         # watch mode
```

**Current coverage:** 1 smoke test (`__tests__/login.smoke.test.tsx`) that
renders the login screen and asserts the primary CTA is present.

**Planned:** end-to-end tests with Maestro or Detox — not yet wired up.
Integration priority is:

1. Auth flow (login → queue → call patient).
2. Booking flow (select doctor → pick slot → confirm).
3. Rx verification (scan QR → verified view).

---

## Building with EAS

EAS commands are not run in CI — they require Apple/Google credentials.
Once `EAS_PROJECT_ID` is set and `eas login` has been completed:

```bash
# Internal dev client (for devs who need native modules beyond Expo Go)
eas build --profile development --platform android
eas build --profile development --platform ios

# Internal QA builds (TestFlight + Android internal track)
eas build --profile preview --platform all

# Store submissions
eas build  --profile production --platform all
eas submit --profile production --platform android
eas submit --profile production --platform ios
```

All three profiles (`development`, `preview`, `production`) are defined in
`eas.json` with the right distribution channel for each.

---

## Push notifications

`lib/hooks/usePushRegistration.ts` is mounted from the root layout once a
user is signed in. Flow:

1. Request notification permission on the device.
2. Call `Notifications.getExpoPushTokenAsync()` to obtain an Expo push token
   (or the underlying FCM/APNs token on bare builds).
3. `POST /notifications/push-token/register` with the token — the API
   stores it on `User.pushToken`.
4. The native dispatcher (`apps/api/src/services/channels/push.ts`) reads
   the token and sends notifications when the API needs to.

### Troubleshooting

If push registration never fires, check in order:

- Permission was actually granted (iOS prompts only once — reinstall the
  build to re-prompt).
- `Device.isDevice === true` — Expo Go on a simulator cannot receive remote
  push.
- The user is logged in (the hook is a no-op otherwise).
- `expoConfig.extra.eas.projectId` resolves to a real EAS project ID.
- Server-side: `User.pushToken` column is populated; check API logs for the
  `/push-token/register` request.

### Credentials (for store builds)

- **iOS:** APNs key in your Apple Developer account, registered with EAS
  via `eas credentials`.
- **Android:** Firebase project + `google-services.json`. Set
  `GOOGLE_SERVICES_JSON=/path/to/google-services.json` before `eas build` —
  `app.config.ts` reads it.

---

## Role-based routing

`app/_layout.tsx` inspects `user.role` after authentication and routes:

- `DOCTOR` → `app/(doctor-tabs)/`
- everything else → `app/(tabs)/` (patient stack)

Unauthenticated users are redirected to `app/login.tsx`.

---

## Known limitations

- **Icon/splash assets are placeholders.** `assets/icon.png`,
  `assets/splash.png`, `assets/adaptive-icon.png`, and
  `assets/notification-icon.png` all need final artwork from a designer
  before store submission. Current files are the Expo defaults plus a
  tinted square.
- **`react-native-razorpay` is not in `dependencies`.** Online billing
  checkout uses a WebView fallback that opens Razorpay's hosted page. If/when
  the native SDK is added, wire it up in `app/(tabs)/billing.tsx`.
- **Doctor-lite is an MVP.** Only 4 tabs, no charting, no lab orders, no
  admissions. The full clinical workflow stays on the web dashboard.
- **No offline mode.** All screens assume network access; there is no
  local cache layer yet.
- **E2E tests not wired up.** Only one jest smoke test today — see the
  Testing section for the planned Maestro/Detox roadmap.
