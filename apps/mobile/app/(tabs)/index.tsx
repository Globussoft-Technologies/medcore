import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { fetchAppointments } from "../../lib/api";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [todayAppts, setTodayAppts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchAppointments({ date: todayISO() });
      setTodayAppts(Array.isArray(data) ? data : []);
    } catch {
      setTodayAppts([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const quickActions = [
    {
      title: "Book Appointment",
      icon: "calendar" as const,
      color: "#2563eb",
      bg: "#eff6ff",
      onPress: () => router.push("/(tabs)/appointments"),
    },
    {
      title: "My Queue Status",
      icon: "people" as const,
      color: "#7c3aed",
      bg: "#f5f3ff",
      onPress: () => router.push("/(tabs)/queue"),
    },
    {
      title: "View Prescriptions",
      icon: "document-text" as const,
      color: "#059669",
      bg: "#ecfdf5",
      onPress: () => router.push("/(tabs)/prescriptions"),
    },
  ];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Hero */}
      <View style={styles.hero}>
        <View>
          <Text style={styles.greeting}>Welcome back,</Text>
          <Text style={styles.userName}>{user?.name || "Patient"}</Text>
        </View>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>
            {(user?.name || "U")[0].toUpperCase()}
          </Text>
        </View>
      </View>

      {/* Quick Actions */}
      <Text style={styles.sectionTitle}>Quick Actions</Text>
      <View style={styles.actionsRow}>
        {quickActions.map((a) => (
          <TouchableOpacity
            key={a.title}
            style={[styles.actionCard, { backgroundColor: a.bg }]}
            onPress={a.onPress}
          >
            <Ionicons name={a.icon} size={28} color={a.color} />
            <Text style={[styles.actionLabel, { color: a.color }]}>
              {a.title}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Today's Appointments */}
      <Text style={styles.sectionTitle}>Today's Appointments</Text>
      {loading ? (
        <ActivityIndicator
          style={{ marginTop: 24 }}
          size="small"
          color="#2563eb"
        />
      ) : todayAppts.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="calendar-outline" size={40} color="#d1d5db" />
          <Text style={styles.emptyText}>No appointments today</Text>
        </View>
      ) : (
        todayAppts.map((apt, i) => (
          <View key={apt.id || i} style={styles.apptCard}>
            <View style={styles.apptRow}>
              <View style={styles.tokenBadge}>
                <Text style={styles.tokenText}>
                  #{apt.tokenNumber ?? "-"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.doctorName}>
                  {apt.doctor?.name || apt.doctorName || "Doctor"}
                </Text>
                <Text style={styles.apptTime}>
                  {apt.slot?.startTime || apt.time || apt.date}
                </Text>
              </View>
              <View
                style={[
                  styles.statusBadge,
                  {
                    backgroundColor:
                      apt.status === "COMPLETED"
                        ? "#dcfce7"
                        : apt.status === "CANCELLED"
                        ? "#fee2e2"
                        : "#dbeafe",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    {
                      color:
                        apt.status === "COMPLETED"
                          ? "#166534"
                          : apt.status === "CANCELLED"
                          ? "#991b1b"
                          : "#1e40af",
                    },
                  ]}
                >
                  {apt.status || "BOOKED"}
                </Text>
              </View>
            </View>
          </View>
        ))
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f4f6",
  },
  hero: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  greeting: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
  },
  userName: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "bold",
    marginTop: 2,
  },
  avatarCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "bold",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#374151",
    marginHorizontal: 20,
    marginTop: 20,
    marginBottom: 12,
  },
  actionsRow: {
    flexDirection: "row",
    paddingHorizontal: 14,
    gap: 10,
  },
  actionCard: {
    flex: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    gap: 8,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyCard: {
    backgroundColor: "#fff",
    marginHorizontal: 20,
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
    gap: 8,
  },
  emptyText: {
    color: "#9ca3af",
    fontSize: 14,
  },
  apptCard: {
    backgroundColor: "#fff",
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 12,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  apptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  tokenBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
  },
  tokenText: {
    color: "#2563eb",
    fontWeight: "bold",
    fontSize: 14,
  },
  doctorName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
  },
  apptTime: {
    fontSize: 13,
    color: "#6b7280",
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "bold",
  },
});
