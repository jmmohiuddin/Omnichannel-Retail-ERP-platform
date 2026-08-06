import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient, sessionStore } from "../lib/services";
import { dashboardCards, type DashboardCard } from "../lib/viewmodels";
import { colors, common } from "./theme";

type Props = NativeStackScreenProps<RootStackParamList, "Dashboard">;

export function DashboardScreen({ navigation }: Props) {
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [summary, dailyDigest] = await Promise.all([
        apiClient.getAnalyticsSummary(),
        apiClient.getDailyDigest().catch(() => null), // digest is best-effort
      ]);
      setCards(dashboardCards(summary));
      setDigest(dailyDigest?.digest ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }, []);

  useEffect(() => {
    void load();
    // Kicked back to Login whenever the session drops (401 → signOut).
    return sessionStore.subscribe((session) => {
      if (!session) navigation.replace("Login");
    });
  }, [load, navigation]);

  return (
    <ScrollView
      style={common.screen}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.subtle}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Text style={common.title}>Today</Text>
      {error && <Text style={common.error}>{error}</Text>}

      {cards.map((card) => (
        <View key={card.key} style={common.card}>
          <Text style={common.subtle}>{card.label}</Text>
          <Text style={[common.text, { fontSize: 24, fontWeight: "700", marginTop: 2 }]}>
            {card.value}
          </Text>
          {card.hint ? <Text style={[common.subtle, { marginTop: 2 }]}>{card.hint}</Text> : null}
        </View>
      ))}

      {digest ? (
        <View style={common.card}>
          <Text style={common.subtle}>Daily digest</Text>
          <Text style={[common.text, { marginTop: 4, lineHeight: 21 }]}>{digest}</Text>
        </View>
      ) : null}

      {(
        [
          ["Approvals", "Approvals"],
          ["Stock lookup", "StockLookup"],
          ["Orders", "Orders"],
        ] as const
      ).map(([label, route]) => (
        <TouchableOpacity
          key={route}
          style={common.button}
          onPress={() => navigation.navigate(route)}
        >
          <Text style={common.buttonText}>{label}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity
        style={[common.button, { backgroundColor: colors.card, marginBottom: 32 }]}
        onPress={() => sessionStore.signOut()}
      >
        <Text style={[common.buttonText, { color: colors.subtle }]}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
