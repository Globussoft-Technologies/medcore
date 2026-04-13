import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Alert,
  TextInput,
  ScrollView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import {
  fetchAppointments,
  fetchDoctors,
  fetchDoctorSlots,
  bookAppointment,
} from "../../lib/api";

function statusColor(status: string) {
  switch (status) {
    case "COMPLETED":
      return { bg: "#dcfce7", text: "#166534" };
    case "CANCELLED":
      return { bg: "#fee2e2", text: "#991b1b" };
    case "IN_PROGRESS":
      return { bg: "#fef9c3", text: "#854d0e" };
    default:
      return { bg: "#dbeafe", text: "#1e40af" };
  }
}

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

export default function AppointmentsScreen() {
  const { user } = useAuth();
  const [appointments, setAppointments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Booking flow state
  const [showBooking, setShowBooking] = useState(false);
  const [step, setStep] = useState(0); // 0=doctors, 1=date, 2=slots, 3=confirm
  const [doctors, setDoctors] = useState<any[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [slots, setSlots] = useState<any[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<any>(null);
  const [booking, setBooking] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const loadAppointments = useCallback(async () => {
    try {
      const data = await fetchAppointments();
      setAppointments(Array.isArray(data) ? data : []);
    } catch {
      setAppointments([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAppointments();
  }, [loadAppointments]);

  const onRefresh = () => {
    setRefreshing(true);
    loadAppointments();
  };

  // Booking helpers
  const openBooking = async () => {
    setShowBooking(true);
    setStep(0);
    setSelectedDoctor(null);
    setSelectedDate("");
    setSelectedSlot(null);
    try {
      const d = await fetchDoctors();
      setDoctors(Array.isArray(d) ? d : []);
    } catch {
      setDoctors([]);
    }
  };

  const pickDoctor = (doc: any) => {
    setSelectedDoctor(doc);
    setStep(1);
    // Default to today's date
    setSelectedDate(new Date().toISOString().slice(0, 10));
  };

  const loadSlots = async () => {
    if (!selectedDoctor || !selectedDate) return;
    setLoadingSlots(true);
    try {
      const s = await fetchDoctorSlots(selectedDoctor.id, selectedDate);
      setSlots(Array.isArray(s) ? s : []);
    } catch {
      setSlots([]);
    } finally {
      setLoadingSlots(false);
    }
    setStep(2);
  };

  const pickSlot = (slot: any) => {
    setSelectedSlot(slot);
    setStep(3);
  };

  const confirmBooking = async () => {
    if (!user || !selectedDoctor || !selectedSlot) return;
    setBooking(true);
    try {
      await bookAppointment({
        patientId: user.id,
        doctorId: selectedDoctor.id,
        date: selectedDate,
        slotId: selectedSlot.id,
      });
      Alert.alert("Success", "Appointment booked!");
      setShowBooking(false);
      loadAppointments();
    } catch (err: any) {
      Alert.alert("Error", err.message || "Could not book appointment");
    } finally {
      setBooking(false);
    }
  };

  const renderAppointment = ({ item }: { item: any }) => {
    const sc = statusColor(item.status || "BOOKED");
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.tokenCircle}>
            <Text style={styles.tokenNum}>#{item.tokenNumber ?? "-"}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.doctorName}>
              {item.doctor?.name || item.doctorName || "Doctor"}
            </Text>
            <Text style={styles.dateText}>{formatDate(item.date)}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.statusText, { color: sc.text }]}>
              {item.status || "BOOKED"}
            </Text>
          </View>
        </View>
        {item.slot && (
          <Text style={styles.slotInfo}>
            {item.slot.startTime} - {item.slot.endTime}
          </Text>
        )}
      </View>
    );
  };

  // Booking modal content per step
  const renderBookingContent = () => {
    if (step === 0) {
      return (
        <>
          <Text style={styles.modalTitle}>Select Doctor</Text>
          <ScrollView style={{ maxHeight: 400 }}>
            {doctors.map((doc) => (
              <TouchableOpacity
                key={doc.id}
                style={styles.listItem}
                onPress={() => pickDoctor(doc)}
              >
                <Ionicons name="medical" size={24} color="#2563eb" />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.listItemTitle}>{doc.name}</Text>
                  <Text style={styles.listItemSub}>
                    {doc.specialization || doc.department || "General"}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
              </TouchableOpacity>
            ))}
            {doctors.length === 0 && (
              <Text style={styles.emptyText}>No doctors available</Text>
            )}
          </ScrollView>
        </>
      );
    }

    if (step === 1) {
      return (
        <>
          <Text style={styles.modalTitle}>Select Date</Text>
          <Text style={styles.modalSub}>
            Doctor: {selectedDoctor?.name}
          </Text>
          <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={selectedDate}
            onChangeText={setSelectedDate}
            placeholder="2026-04-13"
            placeholderTextColor="#9ca3af"
          />
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={loadSlots}
          >
            <Text style={styles.primaryBtnText}>Find Slots</Text>
          </TouchableOpacity>
        </>
      );
    }

    if (step === 2) {
      return (
        <>
          <Text style={styles.modalTitle}>Available Slots</Text>
          <Text style={styles.modalSub}>
            {selectedDoctor?.name} on {selectedDate}
          </Text>
          {loadingSlots ? (
            <ActivityIndicator
              style={{ marginTop: 20 }}
              color="#2563eb"
            />
          ) : (
            <ScrollView style={{ maxHeight: 400 }}>
              {slots.map((slot) => (
                <TouchableOpacity
                  key={slot.id}
                  style={[
                    styles.slotItem,
                    !slot.available && styles.slotUnavailable,
                  ]}
                  onPress={() => slot.available !== false && pickSlot(slot)}
                  disabled={slot.available === false}
                >
                  <Ionicons
                    name="time-outline"
                    size={20}
                    color={slot.available === false ? "#d1d5db" : "#2563eb"}
                  />
                  <Text
                    style={[
                      styles.slotText,
                      slot.available === false && { color: "#d1d5db" },
                    ]}
                  >
                    {slot.startTime} - {slot.endTime}
                  </Text>
                  {slot.available === false && (
                    <Text style={styles.bookedLabel}>Booked</Text>
                  )}
                </TouchableOpacity>
              ))}
              {slots.length === 0 && (
                <Text style={styles.emptyText}>
                  No slots available for this date
                </Text>
              )}
            </ScrollView>
          )}
        </>
      );
    }

    // step === 3 confirm
    return (
      <>
        <Text style={styles.modalTitle}>Confirm Booking</Text>
        <View style={styles.confirmCard}>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Doctor</Text>
            <Text style={styles.confirmValue}>{selectedDoctor?.name}</Text>
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Date</Text>
            <Text style={styles.confirmValue}>{selectedDate}</Text>
          </View>
          <View style={styles.confirmRow}>
            <Text style={styles.confirmLabel}>Slot</Text>
            <Text style={styles.confirmValue}>
              {selectedSlot?.startTime} - {selectedSlot?.endTime}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.primaryBtn, booking && { opacity: 0.7 }]}
          onPress={confirmBooking}
          disabled={booking}
        >
          {booking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Confirm Appointment</Text>
          )}
        </TouchableOpacity>
      </>
    );
  };

  return (
    <View style={styles.container}>
      {loading ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          size="large"
          color="#2563eb"
        />
      ) : (
        <FlatList
          data={appointments}
          keyExtractor={(item, i) => item.id || String(i)}
          renderItem={renderAppointment}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name="calendar-outline" size={48} color="#d1d5db" />
              <Text style={styles.emptyText}>No appointments yet</Text>
            </View>
          }
        />
      )}

      {/* FAB */}
      <TouchableOpacity style={styles.fab} onPress={openBooking}>
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Booking Modal */}
      <Modal
        visible={showBooking}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowBooking(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            {step > 0 ? (
              <TouchableOpacity onPress={() => setStep(step - 1)}>
                <Ionicons name="arrow-back" size={24} color="#374151" />
              </TouchableOpacity>
            ) : (
              <View style={{ width: 24 }} />
            )}
            <Text style={styles.modalHeaderTitle}>Book Appointment</Text>
            <TouchableOpacity onPress={() => setShowBooking(false)}>
              <Ionicons name="close" size={24} color="#374151" />
            </TouchableOpacity>
          </View>
          <View style={styles.modalBody}>{renderBookingContent()}</View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
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
  tokenCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#eff6ff",
    justifyContent: "center",
    alignItems: "center",
  },
  tokenNum: { color: "#2563eb", fontWeight: "bold", fontSize: 14 },
  doctorName: { fontSize: 15, fontWeight: "600", color: "#111827" },
  dateText: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  slotInfo: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 8,
    marginLeft: 56,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: { fontSize: 11, fontWeight: "bold" },
  emptyWrap: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { color: "#9ca3af", fontSize: 14, textAlign: "center", marginTop: 8 },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#2563eb",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  // Modal
  modalContainer: { flex: 1, backgroundColor: "#fff" },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  modalHeaderTitle: { fontSize: 17, fontWeight: "bold", color: "#111827" },
  modalBody: { flex: 1, padding: 20 },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 4,
  },
  modalSub: { fontSize: 14, color: "#6b7280", marginBottom: 16 },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
  },
  listItemTitle: { fontSize: 15, fontWeight: "600", color: "#111827" },
  listItemSub: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 14,
    fontSize: 16,
    color: "#111827",
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 20,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "bold" },
  slotItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    gap: 10,
  },
  slotUnavailable: { opacity: 0.5 },
  slotText: { fontSize: 15, color: "#111827", flex: 1 },
  bookedLabel: { fontSize: 12, color: "#ef4444", fontWeight: "600" },
  confirmCard: {
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    gap: 12,
  },
  confirmRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  confirmLabel: { fontSize: 14, color: "#6b7280" },
  confirmValue: { fontSize: 14, fontWeight: "600", color: "#111827" },
});
