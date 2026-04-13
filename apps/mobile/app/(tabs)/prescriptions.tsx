import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { fetchPrescriptions, fetchPrescriptionDetail } from "../../lib/api";

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

export default function PrescriptionsScreen() {
  const { user } = useAuth();
  const [prescriptions, setPrescriptions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, any>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchPrescriptions(user?.id);
      setPrescriptions(Array.isArray(data) ? data : []);
    } catch {
      setPrescriptions([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detailCache[id]) {
      setLoadingDetail(id);
      try {
        const detail = await fetchPrescriptionDetail(id);
        setDetailCache((prev) => ({ ...prev, [id]: detail }));
      } catch {
        // keep expanded but empty
      } finally {
        setLoadingDetail(null);
      }
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    const isExpanded = expandedId === item.id;
    const detail = detailCache[item.id] || item;
    const medicines: any[] =
      detail.medicines || detail.items || detail.medications || [];

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => toggleExpand(item.id)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={styles.rxCircle}>
            <Text style={styles.rxText}>Rx</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.diagnosis}>
              {item.diagnosis || "Prescription"}
            </Text>
            <Text style={styles.doctorText}>
              {item.doctor?.name || item.doctorName || "Doctor"}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.dateText}>{formatDate(item.date || item.createdAt)}</Text>
            <Ionicons
              name={isExpanded ? "chevron-up" : "chevron-down"}
              size={18}
              color="#9ca3af"
              style={{ marginTop: 4 }}
            />
          </View>
        </View>

        {isExpanded && (
          <View style={styles.expandedSection}>
            {loadingDetail === item.id ? (
              <ActivityIndicator
                style={{ marginVertical: 12 }}
                color="#2563eb"
              />
            ) : medicines.length > 0 ? (
              <>
                {/* Table header */}
                <View style={styles.tableHeader}>
                  <Text style={[styles.thText, { flex: 2 }]}>Medicine</Text>
                  <Text style={[styles.thText, { flex: 1 }]}>Dosage</Text>
                  <Text style={[styles.thText, { flex: 1 }]}>Duration</Text>
                </View>
                {medicines.map((med: any, idx: number) => (
                  <View
                    key={med.id || idx}
                    style={[
                      styles.tableRow,
                      idx % 2 === 0 && { backgroundColor: "#f9fafb" },
                    ]}
                  >
                    <Text style={[styles.tdText, { flex: 2 }]}>
                      {med.name || med.medicineName || med.medicine}
                    </Text>
                    <Text style={[styles.tdText, { flex: 1 }]}>
                      {med.dosage || "-"}
                    </Text>
                    <Text style={[styles.tdText, { flex: 1 }]}>
                      {med.duration || med.days || "-"}
                    </Text>
                  </View>
                ))}
              </>
            ) : (
              <Text style={styles.noMeds}>No medicines listed</Text>
            )}
            {detail.notes && (
              <View style={styles.notesBox}>
                <Text style={styles.notesLabel}>Notes</Text>
                <Text style={styles.notesText}>{detail.notes}</Text>
              </View>
            )}
          </View>
        )}
      </TouchableOpacity>
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
      data={prescriptions}
      keyExtractor={(item, i) => item.id || String(i)}
      renderItem={renderItem}
      contentContainerStyle={{ padding: 16 }}
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      ListEmptyComponent={
        <View style={styles.emptyWrap}>
          <Ionicons name="document-text-outline" size={48} color="#d1d5db" />
          <Text style={styles.emptyText}>No prescriptions yet</Text>
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
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rxCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ecfdf5",
    justifyContent: "center",
    alignItems: "center",
  },
  rxText: { color: "#059669", fontWeight: "bold", fontSize: 16 },
  diagnosis: { fontSize: 15, fontWeight: "600", color: "#111827" },
  doctorText: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  dateText: { fontSize: 12, color: "#9ca3af" },
  expandedSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#f3f4f6",
    paddingTop: 12,
  },
  tableHeader: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  thText: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#6b7280",
    textTransform: "uppercase",
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  tdText: {
    fontSize: 13,
    color: "#374151",
  },
  noMeds: {
    color: "#9ca3af",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 12,
  },
  notesBox: {
    marginTop: 10,
    backgroundColor: "#fffbeb",
    borderRadius: 8,
    padding: 10,
  },
  notesLabel: { fontSize: 12, fontWeight: "bold", color: "#92400e" },
  notesText: { fontSize: 13, color: "#78350f", marginTop: 4 },
  emptyWrap: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { color: "#9ca3af", fontSize: 14 },
});
