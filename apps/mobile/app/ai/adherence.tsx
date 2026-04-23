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
import { useFocusEffect } from "expo-router";
import { useAuth } from "../../lib/auth";
import {
  fetchAdherenceSchedules,
  fetchDoseLog,
  markDoseTaken,
  type AdherenceSchedule,
  type AdherenceMedication,
} from "../../lib/ai";

type DoseKey = string; // `${YYYY-MM-DD}__${scheduleId}__${medName}__${HH:mm}`

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayKeyFor(
  scheduleId: string,
  medName: string,
  time: string
): DoseKey {
  return `${dateKey(new Date())}__${scheduleId}__${medName}__${time}`;
}

/**
 * Combine today's YYYY-MM-DD with a HH:mm reminder time into an ISO date-time
 * string the server can accept as `scheduledAt`.
 */
function scheduledAtIsoFor(time: string): string {
  const [hh, mm] = time.split(":");
  const d = new Date();
  d.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
  return d.toISOString();
}

/**
 * Build the client-state key for an existing server dose-log row. Uses the
 * row's `scheduledAt` (UTC day + HH:mm) so a server-side TAKEN row and a
 * locally-toggled chip collide on the same key.
 */
function keyFromLog(
  scheduleId: string,
  medName: string,
  scheduledAt: string
): DoseKey {
  const d = new Date(scheduledAt);
  const day = dateKey(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}__${scheduleId}__${medName}__${hh}:${mm}`;
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

  /**
   * Fetches the last 7 days of dose logs across all active schedules and
   * hydrates `takenDoses` so chips persist across reloads / app launches.
   */
  const hydrateFromServer = useCallback(
    async (list: AdherenceSchedule[]) => {
      if (!list.length) return;
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 7);
      try {
        const results = await Promise.all(
          list.map((s) =>
            fetchDoseLog(s.id, from.toISOString(), now.toISOString()).catch(() => [])
          )
        );
        const next: Record<DoseKey, boolean> = {};
        results.forEach((logs, idx) => {
          const schedule = list[idx];
          for (const log of logs) {
            if (log.skipped) continue;
            next[keyFromLog(schedule.id, log.medicationName, log.scheduledAt)] = true;
          }
        });
        setTakenDoses((prev) => ({ ...prev, ...next }));
      } catch {
        // Hydration is best-effort; ignore errors.
      }
    },
    []
  );

  // Re-hydrate every time the screen gains focus so a dose logged from
  // another device (or pushed by the backend scheduler) is reflected.
  useFocusEffect(
    useCallback(() => {
      if (schedules.length) void hydrateFromServer(schedules);
    }, [schedules, hydrateFromServer])
  );

  const markDose = async (
    scheduleId: string,
    med: AdherenceMedication,
    time: string
  ) => {
    const key = todayKeyFor(scheduleId, med.name, time);
    const wasTaken = !!takenDoses[key];
    // Optimistic toggle
    setTakenDoses((prev) => ({ ...prev, [key]: !wasTaken }));

    // Only persist the "mark as taken" transition to the server. Toggling
    // back to untaken is a local-only undo — the server has no "delete dose"
    // endpoint yet, and appending another row would double-count.
    if (wasTaken) return;

    try {
      const scheduledAt = scheduledAtIsoFor(time);
      await markDoseTaken(scheduleId, {
        medicationName: med.name,
        scheduledAt,
        takenAt: new Date().toISOString(),
      });
    } catch (err: any) {
      // Revert on failure
      setTakenDoses((prev) => ({ ...prev, [key]: wasTaken }));
      Alert.alert(
        "Could not record dose",
        err?.message || "Please check your connection and try again."
      );
    }
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
