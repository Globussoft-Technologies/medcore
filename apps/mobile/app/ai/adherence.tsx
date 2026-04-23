import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import {
  fetchAdherenceSchedules,
  type AdherenceSchedule,
  type AdherenceMedication,
} from "../../lib/ai";

type DoseKey = string; // `${scheduleId}__${medName}__${time}`

function todayKeyFor(
  scheduleId: string,
  medName: string,
  time: string
): DoseKey {
  const d = new Date().toISOString().slice(0, 10);
  return `${d}__${scheduleId}__${medName}__${time}`;
}

export default function AdherenceScreen() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState<AdherenceSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takenDoses, setTakenDoses] = useState<Record<DoseKey, boolean>>({});

  const patientId = (user as any)?.patientId ?? user?.id;

  const load = useCallback(
    async (isRefresh = false) => {
      if (!patientId) {
        setLoading(false);
        setError("No patient profile linked to this account.");
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await fetchAdherenceSchedules(patientId);
        setSchedules(Array.isArray(data) ? data : []);
      } catch (err: any) {
        setError(err?.message || "Could not load medication schedule");
        setSchedules([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [patientId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const markDose = (scheduleId: string, med: AdherenceMedication, time: string) => {
    const key = todayKeyFor(scheduleId, med.name, time);
    setTakenDoses((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderItem = ({ item: schedule }: { item: AdherenceSchedule }) => {
    const medications = Array.isArray(schedule.medications) ? schedule.medications : [];
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.pillIcon}>
            <Ionicons name="medical" size={18} color="#059669" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.scheduleTitle}>
              {medications.length} medication{medications.length === 1 ? "" : "s"}
            </Text>
            <Text style={styles.scheduleMeta}>
              {new Date(schedule.startDate).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}{" "}
              –{" "}
              {new Date(schedule.endDate).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}
            </Text>
          </View>
          <View style={styles.reminderBadge}>
            <Ionicons name="notifications" size={12} color="#1e40af" />
            <Text style={styles.reminderText}>{schedule.remindersSent}</Text>
          </View>
        </View>

        {medications.map((med, i) => (
          <View key={`${med.name}-${i}`} style={styles.medBlock}>
            <View style={styles.medHeader}>
              <Text style={styles.medName}>{med.name}</Text>
              <Text style={styles.medDosage}>{med.dosage}</Text>
            </View>
            <Text style={styles.medFreq}>
              {med.frequency} • {med.duration}
            </Text>

            {med.reminderTimes && med.reminderTimes.length > 0 && (
              <View style={styles.timesRow}>
                {med.reminderTimes.map((time) => {
                  const key = todayKeyFor(schedule.id, med.name, time);
                  const taken = takenDoses[key];
                  return (
                    <TouchableOpacity
                      key={time}
                      style={[styles.timeChip, taken && styles.timeChipTaken]}
                      onPress={() => markDose(schedule.id, med, time)}
                      accessibilityLabel={`Dose at ${time}${taken ? ", taken" : ""}`}
                    >
                      <Ionicons
                        name={taken ? "checkmark-circle" : "time-outline"}
                        size={14}
                        color={taken ? "#059669" : "#2563eb"}
                      />
                      <Text
                        style={[styles.timeChipText, taken && styles.timeChipTextTaken]}
                      >
                        {time}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        ))}
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
      data={schedules}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Ionicons name="alarm" size={22} color="#fff" />
          <Text style={styles.headerTitle}>Medication Reminders</Text>
        </View>
      }
      ListEmptyComponent={
        error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={20} color="#991b1b" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <View style={styles.emptyWrap}>
            <Ionicons name="medkit-outline" size={48} color="#d1d5db" />
            <Text style={styles.emptyText}>No active medication reminders</Text>
            <Text style={styles.emptyHint}>
              Your doctor can enroll your prescription to start reminders.
            </Text>
          </View>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 12,
    marginBottom: 16,
  },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "bold" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  pillIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#ecfdf5",
    justifyContent: "center",
    alignItems: "center",
  },
  scheduleTitle: { fontSize: 15, fontWeight: "700", color: "#111827" },
  scheduleMeta: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  reminderBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#eff6ff",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  reminderText: { fontSize: 12, fontWeight: "700", color: "#1e40af" },
  medBlock: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
  },
  medHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  medName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  medDosage: { fontSize: 12, color: "#6b7280", fontWeight: "600" },
  medFreq: { fontSize: 12, color: "#6b7280", marginTop: 3 },
  timesRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: "#eff6ff",
    borderRadius: 14,
  },
  timeChipTaken: { backgroundColor: "#ecfdf5" },
  timeChipText: { color: "#2563eb", fontSize: 12, fontWeight: "600" },
  timeChipTextTaken: { color: "#059669", textDecorationLine: "line-through" },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    backgroundColor: "#fee2e2",
    borderRadius: 8,
    marginTop: 8,
  },
  errorText: { color: "#991b1b", fontSize: 13, flex: 1 },
  emptyWrap: { alignItems: "center", marginTop: 40, gap: 8, paddingHorizontal: 32 },
  emptyText: { color: "#6b7280", fontSize: 15, fontWeight: "600" },
  emptyHint: { color: "#9ca3af", fontSize: 13, textAlign: "center" },
});
