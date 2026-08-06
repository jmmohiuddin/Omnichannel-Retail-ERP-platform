import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient } from "../lib/services";
import type { ApprovalDto } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { approvalRow } from "../lib/viewmodels";
import { colors, common } from "./theme";
import { useLang } from "./useLang";

type Props = NativeStackScreenProps<RootStackParamList, "Approvals">;

export function ApprovalsScreen(_props: Props) {
  const lang = useLang();
  const [items, setItems] = useState<ApprovalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await apiClient.listApprovals());
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, "approvals.loadFailed"));
    }
  }, [lang]);

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
      setError(err instanceof Error ? err.message : t(lang, "approvals.decisionFailed"));
    } finally {
      setBusyId(null);
    }
  }

  // Inline flip only — full native RTL via I18nManager needs an app reload.
  const rowDirection = isRtl(lang) ? "row-reverse" : "row";

  return (
    <View style={common.screen}>
      <Text style={common.title}>{t(lang, "approvals.title")}</Text>
      {error && <Text style={common.error}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={(a) => a.id}
        ListEmptyComponent={<Text style={common.subtle}>{t(lang, "approvals.empty")}</Text>}
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
              <Text style={[common.subtle, { marginTop: 2 }]}>
                {t(lang, "approvals.reason", { reason: row.reason })}
              </Text>
              <View style={{ flexDirection: rowDirection, gap: 10, marginTop: 10 }}>
                <TouchableOpacity
                  style={[common.button, { flex: 1, backgroundColor: colors.positive }]}
                  disabled={busyId === item.id}
                  onPress={() => void decide(item.id, true)}
                >
                  <Text style={common.buttonText}>{t(lang, "approvals.approve")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[common.button, { flex: 1, backgroundColor: colors.negative }]}
                  disabled={busyId === item.id}
                  onPress={() => void decide(item.id, false)}
                >
                  <Text style={common.buttonText}>{t(lang, "approvals.reject")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}
