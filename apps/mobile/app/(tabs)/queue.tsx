import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { fetchQueue, fetchAppointments } from "../../lib/api";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function QueueScreen() {
  const { user } = useAuth();
  const [queueData, setQueueData] = useState<any[]>([]);
  const [myAppts, setMyAppts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, appts] = await Promise.all([
        fetchQueue(),
        fetchAppointments({ date: todayISO() }),
      ]);
      setQueueData(Array.isArray(q) ? q : []);
      setMyAppts(Array.isArray(appts) ? appts : []);
    } catch {
      setQueueData([]);
      setMyAppts([]);
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

  // Find if the patient has an active appointment with a specific doctor today
  const myDoctorIds = new Set(
    myAppts
      .filter(
        (a) =>
          a.status !== "COMPLETED" &&
          a.status !== "CANCELLED"
      )
      .map((a) => a.doctorId || a.doctor?.id)
  );

  const renderItem = ({ item }: { item: any }) => {
    const isMyDoctor = myDoctorIds.has(item.doctorId || item.id);
    const myAppt = isMyDoctor
      ? myAppts.find(
          (a) =>
            (a.doctorId === item.doctorId || a.doctor?.id === item.doctorId || a.doctorId === item.id) &&
            a.status !== "COMPLETED" &&
            a.status !== "CANCELLED"
        )
      : null;

    return (
      <View
        style={[
          styles.card,
          isMyDoctor && styles.cardHighlight,
        ]}
      >
        <View style={styles.row}>
          <View
            style={[
              styles.iconCircle,
              isMyDoctor && { backgroundColor: "#dbeafe" },
            ]}
          >
            <Ionicons
              name="medical"
              size={24}
              color={isMyDoctor ? "#2563eb" : "#6b7280"}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.doctorName}>
              {item.doctorName || item.name || "Doctor"}
            </Text>
            <Text style={styles.dept}>
              {item.specialization || item.department || "General"}
            </Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Current Token</Text>
            <Text style={styles.statValue}>
              #{item.currentToken ?? item.currentTokenNumber ?? "-"}
            </Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Waiting</Text>
            <Text style={styles.statValue}>
              {item.waitingCount ?? item.waiting ?? "-"}
            </Text>
          </View>
        </View>

        {myAppt && (
          <View style={styles.myBadge}>
            <Ionicons name="person" size={14} color="#2563eb" />
            <Text style={styles.myBadgeText}>
              Your token: #{myAppt.tokenNumber ?? "-"}
            </Text>
          </View>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <FlatList
      data={queueData}
      keyExtractor={(item, i) => item.id || item.doctorId || String(i)}
      renderItem={renderItem}
      contentContainerStyle={{ padding: 16 }}
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      ListEmptyComponent={
        <View style={styles.emptyWrap}>
          <Ionicons name="people-outline" size={48} color="#d1d5db" />
          <Text style={styles.emptyText}>No queue information available</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  cardHighlight: {
    borderWidth: 2,
    borderColor: "#2563eb",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#f3f4f6",
    justifyContent: "center",
    alignItems: "center",
  },
  doctorName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  dept: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  statsRow: {
    flexDirection: "row",
    marginTop: 12,
    backgroundColor: "#f9fafb",
    borderRadius: 8,
    padding: 10,
  },
  stat: { flex: 1, alignItems: "center" },
  statLabel: { fontSize: 12, color: "#6b7280" },
  statValue: { fontSize: 18, fontWeight: "bold", color: "#111827", marginTop: 2 },
  divider: {
    width: 1,
    backgroundColor: "#e5e7eb",
  },
  myBadge: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    backgroundColor: "#eff6ff",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 6,
    alignSelf: "flex-start",
  },
  myBadgeText: { fontSize: 13, color: "#2563eb", fontWeight: "600" },
  emptyWrap: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { color: "#9ca3af", fontSize: 14 },
});
