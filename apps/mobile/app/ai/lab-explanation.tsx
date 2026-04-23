import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TextInput,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  fetchLabExplanation,
  type LabReportExplanation,
  type LabFlaggedValue,
} from "../../lib/ai";

const FLAG_CONFIG: Record<
  string,
  { label: string; bg: string; text: string }
> = {
  NORMAL: { label: "Normal", bg: "#dcfce7", text: "#166534" },
  HIGH: { label: "High", bg: "#fef3c7", text: "#92400e" },
  LOW: { label: "Low", bg: "#dbeafe", text: "#1e40af" },
  CRITICAL_HIGH: { label: "Critical High", bg: "#fee2e2", text: "#991b1b" },
  CRITICAL_LOW: { label: "Critical Low", bg: "#fee2e2", text: "#991b1b" },
  ABNORMAL: { label: "Abnormal", bg: "#fef3c7", text: "#92400e" },
};

function FlagChip({ flag }: { flag: string }) {
  const cfg = FLAG_CONFIG[flag] ?? { label: flag, bg: "#f3f4f6", text: "#374151" };
  return (
    <View style={[styles.chip, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.chipText, { color: cfg.text }]}>{cfg.label}</Text>
    </View>
  );
}

export default function LabExplanationScreen() {
  // Supports either ?labOrderId=... or prompts the user.
  const { labOrderId: paramOrderId } = useLocalSearchParams<{ labOrderId?: string }>();
  const [labOrderId, setLabOrderId] = useState<string>(paramOrderId ?? "");
  const [explanation, setExplanation] = useState<LabReportExplanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (id: string, isRefresh = false) => {
    if (!id.trim()) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await fetchLabExplanation(id.trim());
      setExplanation(data);
    } catch (err: any) {
      setError(err?.message || "Could not load explanation");
      setExplanation(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (paramOrderId) void load(paramOrderId);
  }, [paramOrderId]);

  const onRefresh = () => {
    if (labOrderId) void load(labOrderId, true);
  };

  const flagged: LabFlaggedValue[] = Array.isArray(explanation?.flaggedValues)
    ? explanation!.flaggedValues
    : [];
  const abnormal = flagged.filter((fv) => fv.flag !== "NORMAL");

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <Ionicons name="flask" size={22} color="#fff" />
        <Text style={styles.headerTitle}>Lab Report Explanation</Text>
      </View>

      {/* Input card */}
      <View style={styles.inputCard}>
        <Text style={styles.inputLabel}>Lab Order ID</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter your lab order ID"
          placeholderTextColor="#9ca3af"
          value={labOrderId}
          onChangeText={setLabOrderId}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.loadButton, !labOrderId.trim() && styles.loadButtonDisabled]}
          onPress={() => load(labOrderId)}
          disabled={!labOrderId.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.loadButtonText}>View Explanation</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Error */}
      {error && (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle" size={18} color="#991b1b" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Empty hint */}
      {!loading && !explanation && !error && (
        <View style={styles.emptyWrap}>
          <Ionicons name="document-text-outline" size={48} color="#d1d5db" />
          <Text style={styles.emptyText}>
            Enter a lab order ID to view its AI-generated explanation.
          </Text>
        </View>
      )}

      {/* Result */}
      {explanation && (
        <View style={styles.resultCard}>
          <View style={styles.resultHeader}>
            <Text style={styles.resultTitle}>Your Results</Text>
            <Text style={styles.resultMeta}>
              {new Date(explanation.createdAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </Text>
          </View>

          {/* Abnormal summary */}
          {abnormal.length > 0 && (
            <View style={styles.abnormalBox}>
              <View style={styles.abnormalHeader}>
                <Ionicons name="warning" size={16} color="#92400e" />
                <Text style={styles.abnormalTitle}>
                  {abnormal.length} abnormal value{abnormal.length === 1 ? "" : "s"}
                </Text>
              </View>
              {abnormal.map((fv, i) => (
                <View key={i} style={styles.abnormalRow}>
                  <Text style={styles.paramName}>{fv.parameter}</Text>
                  <Text style={styles.paramValue}>{fv.value}</Text>
                  <FlagChip flag={fv.flag} />
                </View>
              ))}
            </View>
          )}

          {/* Explanation */}
          <Text style={styles.sectionLabel}>What this means</Text>
          <Text style={styles.explanationText}>{explanation.explanation}</Text>

          {/* Full results */}
          {flagged.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>All parameters</Text>
              {flagged.map((fv, i) => (
                <View key={i} style={styles.paramRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.paramName}>{fv.parameter}</Text>
                    {fv.plainLanguage ? (
                      <Text style={styles.paramNote}>{fv.plainLanguage}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.paramValue}>{fv.value}</Text>
                  <FlagChip flag={fv.flag} />
                </View>
              ))}
            </>
          )}

          <Text style={styles.disclaimer}>
            This explanation is generated by AI and reviewed by your doctor.
            Please follow up with your physician for clinical decisions.
          </Text>
        </View>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
  header: {
    backgroundColor: "#2563eb",
    paddingTop: 16,
    paddingBottom: 14,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "bold" },
  inputCard: {
    backgroundColor: "#fff",
    margin: 16,
    padding: 14,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6b7280",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#111827",
    backgroundColor: "#f9fafb",
    marginBottom: 10,
  },
  loadButton: {
    backgroundColor: "#2563eb",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  loadButtonDisabled: { backgroundColor: "#9ca3af" },
  loadButtonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    padding: 12,
    backgroundColor: "#fee2e2",
    borderRadius: 8,
  },
  errorText: { color: "#991b1b", fontSize: 13, flex: 1 },
  emptyWrap: { alignItems: "center", marginTop: 40, paddingHorizontal: 32, gap: 10 },
  emptyText: { color: "#9ca3af", fontSize: 14, textAlign: "center" },
  resultCard: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  resultTitle: { fontSize: 16, fontWeight: "bold", color: "#111827" },
  resultMeta: { fontSize: 12, color: "#9ca3af" },
  abnormalBox: {
    backgroundColor: "#fffbeb",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  abnormalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  abnormalTitle: { fontSize: 13, fontWeight: "700", color: "#92400e" },
  abnormalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    marginTop: 6,
    marginBottom: 6,
  },
  explanationText: {
    fontSize: 14,
    color: "#111827",
    lineHeight: 21,
    marginBottom: 12,
  },
  paramRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  paramName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  paramValue: { fontSize: 13, color: "#4b5563" },
  paramNote: { fontSize: 11, color: "#6b7280", marginTop: 2 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  chipText: { fontSize: 11, fontWeight: "700" },
  disclaimer: {
    marginTop: 16,
    fontSize: 11,
    color: "#9ca3af",
    fontStyle: "italic",
    textAlign: "center",
  },
});
