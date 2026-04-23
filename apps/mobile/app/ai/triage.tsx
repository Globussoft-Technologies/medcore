import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import {
  startTriageSession,
  sendTriageMessage,
  getTriageSummary,
  bookTriageAppointment,
  type TriageMessage,
  type TriageDoctorSuggestion,
} from "../../lib/ai";

type ChatBubble = { role: "user" | "assistant"; content: string };

export default function AITriageChatScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [draft, setDraft] = useState("");
  const [isEmergency, setIsEmergency] = useState(false);
  const [starting, setStarting] = useState(true);
  const [sending, setSending] = useState(false);
  const [doctorSuggestions, setDoctorSuggestions] = useState<TriageDoctorSuggestion[]>([]);
  const [booking, setBooking] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatBubble>>(null);

  // Kick off a new session on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await startTriageSession({
          language: "en",
          inputMode: "text",
        });
        if (!mounted) return;
        setSessionId(res.sessionId);
        setMessages([{ role: "assistant", content: res.message }]);
      } catch (err: any) {
        Alert.alert("Could not start chat", err?.message || "Please try again.");
      } finally {
        if (mounted) setStarting(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !sessionId || sending) return;

    // Optimistically append user bubble.
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setDraft("");
    setSending(true);
    scrollToEnd();

    try {
      const resp = await sendTriageMessage(sessionId, text);
      setMessages((prev) => [...prev, { role: "assistant", content: resp.message }]);
      if (resp.isEmergency) {
        setIsEmergency(true);
      } else if (resp.sessionStatus === "AWAITING_BOOKING") {
        // Fetch doctor suggestions once triage decides on a specialty.
        try {
          const summary = await getTriageSummary(sessionId);
          setDoctorSuggestions(summary.doctorSuggestions ?? []);
        } catch {
          /* ignore — user can retry */
        }
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I couldn't reach the server. Please try again.",
        },
      ]);
    } finally {
      setSending(false);
      scrollToEnd();
    }
  };

  const handleBookDoctor = async (doc: TriageDoctorSuggestion) => {
    if (!sessionId) return;
    setBooking(doc.doctorId);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await bookTriageAppointment(sessionId, {
        doctorId: doc.doctorId,
        date: today,
        slotStart: "09:00",
      });
      Alert.alert(
        "Appointment requested",
        `We have requested an appointment with ${doc.name}. You'll receive a confirmation shortly.`
      );
      router.replace("/(tabs)/appointments");
    } catch (err: any) {
      Alert.alert("Booking failed", err?.message || "Please try again.");
    } finally {
      setBooking(null);
    }
  };

  const renderBubble = ({ item }: { item: ChatBubble }) => {
    const isUser = item.role === "user";
    return (
      <View
        style={[
          styles.bubbleRow,
          isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant,
        ]}
      >
        <View
          style={[
            styles.bubble,
            isUser ? styles.bubbleUser : styles.bubbleAssistant,
          ]}
        >
          <Text style={isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  if (starting) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Starting AI Triage...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="medkit" size={22} color="#fff" />
        <Text style={styles.headerTitle}>AI Triage</Text>
      </View>

      {/* Emergency banner */}
      {isEmergency && (
        <View style={styles.emergencyBanner}>
          <Ionicons name="warning" size={18} color="#fff" />
          <Text style={styles.emergencyText}>
            Possible emergency detected. Please call 108 or go to the nearest ER.
          </Text>
        </View>
      )}

      {/* Chat thread */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderBubble}
        contentContainerStyle={styles.threadContent}
        onContentSizeChange={scrollToEnd}
        ListFooterComponent={
          sending ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator size="small" color="#9ca3af" />
              <Text style={styles.thinkingText}>Thinking...</Text>
            </View>
          ) : null
        }
      />

      {/* Doctor suggestions */}
      {doctorSuggestions.length > 0 && (
        <View style={styles.suggestionsWrap}>
          <Text style={styles.suggestionsTitle}>Suggested doctors</Text>
          {doctorSuggestions.slice(0, 3).map((doc) => (
            <View key={doc.doctorId} style={styles.doctorCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.doctorName}>{doc.name}</Text>
                <Text style={styles.doctorSpecialty}>{doc.specialty}</Text>
              </View>
              <TouchableOpacity
                style={styles.bookButton}
                disabled={booking === doc.doctorId}
                onPress={() => handleBookDoctor(doc)}
              >
                {booking === doc.doctorId ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.bookButtonText}>Book</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={
            isEmergency
              ? "Chat paused — please seek immediate care"
              : "Describe your symptoms..."
          }
          placeholderTextColor="#9ca3af"
          value={draft}
          onChangeText={setDraft}
          editable={!sending && !isEmergency}
          multiline
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            (!draft.trim() || sending || isEmergency) && styles.sendButtonDisabled,
          ]}
          onPress={handleSend}
          disabled={!draft.trim() || sending || isEmergency}
          accessibilityLabel="Send message"
        >
          <Ionicons name="send" size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f4f6" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  loadingText: { color: "#6b7280", fontSize: 14 },
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
  emergencyBanner: {
    backgroundColor: "#dc2626",
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  emergencyText: { color: "#fff", fontSize: 13, flex: 1, fontWeight: "600" },
  threadContent: { padding: 14, paddingBottom: 24 },
  bubbleRow: { flexDirection: "row", marginVertical: 4 },
  bubbleRowUser: { justifyContent: "flex-end" },
  bubbleRowAssistant: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
  },
  bubbleUser: { backgroundColor: "#2563eb", borderBottomRightRadius: 4 },
  bubbleAssistant: {
    backgroundColor: "#fff",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  bubbleTextUser: { color: "#fff", fontSize: 14, lineHeight: 20 },
  bubbleTextAssistant: { color: "#111827", fontSize: 14, lineHeight: 20 },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  thinkingText: { color: "#9ca3af", fontSize: 12, fontStyle: "italic" },
  suggestionsWrap: {
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  suggestionsTitle: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#6b7280",
    textTransform: "uppercase",
    marginBottom: 8,
  },
  doctorCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    marginBottom: 6,
  },
  doctorName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  doctorSpecialty: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  bookButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#2563eb",
    borderRadius: 8,
    minWidth: 64,
    alignItems: "center",
  },
  bookButtonText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: "#111827",
    backgroundColor: "#f9fafb",
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#2563eb",
    justifyContent: "center",
    alignItems: "center",
  },
  sendButtonDisabled: { backgroundColor: "#9ca3af" },
});
