import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient } from "../lib/services";
import type { ApprovalDto } from "../lib/api";
import { approvalRow } from "../lib/viewmodels";
import { colors, common } from "./theme";

type Props = NativeStackScreenProps<RootStackParamList, "Approvals">;

export function ApprovalsScreen(_props: Props) {
  const [items, setItems] = useState<ApprovalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await apiClient.listApprovals());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, approve: boolean) {
    setBusyId(id);
    try {
      await apiClient.decideApproval(id, approve);
      await load();
    } catch (err) {
      // e.g. 403 SELF_APPROVAL — surface the server's explanation.
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <View style={common.screen}>
      <Text style={common.title}>Approvals</Text>
      {error && <Text style={common.error}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={(a) => a.id}
        ListEmptyComponent={
          <Text style={common.subtle}>Nothing waiting for approval.</Text>
        }
        renderItem={({ item }) => {
          const row = approvalRow(item);
          return (
            <View style={common.card}>
              <Text style={[common.text, { fontWeight: "700" }]}>
                {row.summary}
              </Text>
              <Text style={[common.subtle, { marginTop: 2 }]}>
                {row.kindLabel} · {row.requestedBy} · {row.age}
              </Text>
              <Text style={[common.subtle, { marginTop: 2 }]}>Reason: {row.reason}</Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                <TouchableOpacity
                  style={[common.button, { flex: 1, backgroundColor: colors.positive }]}
                  disabled={busyId === item.id}
                  onPress={() => void decide(item.id, true)}
                >
                  <Text style={common.buttonText}>Approve</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[common.button, { flex: 1, backgroundColor: colors.negative }]}
                  disabled={busyId === item.id}
                  onPress={() => void decide(item.id, false)}
                >
                  <Text style={common.buttonText}>Reject</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
