import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../lib/auth";
import { usePushRegistration } from "../lib/hooks/usePushRegistration";

/**
 * Routes the user to the correct stack based on auth state + role.
 * - PATIENT (and unknown roles) -> (tabs)
 * - DOCTOR                       -> (doctor-tabs)
 * - unauthenticated              -> /login
 */
function RoleRouter() {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register the device for push as soon as we have a logged-in user.
  usePushRegistration(!!user);

  useEffect(() => {
    if (isLoading) return;

    const seg0 = segments[0];
    const inAuthGroup = seg0 === "login" || seg0 === "register";
    const inPatientTabs = seg0 === "(tabs)";
    const inDoctorTabs = seg0 === "(doctor-tabs)";
    // Shared feature routes (e.g. AI screens) accessible from either tab stack.
    const inSharedFeature = seg0 === "ai";

    if (!user && !inAuthGroup && seg0 !== undefined && seg0 !== "index") {
      router.replace("/login");
      return;
    }
    if (user) {
      const role = (user.role || "").toUpperCase();
      if (role === "DOCTOR" && !inDoctorTabs && !inSharedFeature) {
        router.replace("/(doctor-tabs)");
      } else if (role !== "DOCTOR" && !inPatientTabs && !inAuthGroup && !inSharedFeature) {
        if (seg0 !== "(tabs)") router.replace("/(tabs)");
      }
    }
  }, [user, isLoading, segments]);

  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RoleRouter />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#2563eb" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "bold" },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ title: "Create Account" }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(doctor-tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="ai/triage" options={{ title: "AI Triage" }} />
        <Stack.Screen name="ai/lab-explanation" options={{ title: "Lab Results" }} />
        <Stack.Screen name="ai/adherence" options={{ title: "My Medications" }} />
      </Stack>
    </AuthProvider>
  );
}
