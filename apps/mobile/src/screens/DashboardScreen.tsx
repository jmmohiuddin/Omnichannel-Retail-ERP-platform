import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient, sessionStore } from "../lib/services";
import type { AnalyticsSummary } from "../lib/api";
import { isRtl, t, type MessageKey } from "../lib/i18n";
import { dashboardCards } from "../lib/viewmodels";
import { colors, common } from "./theme";
import { toggleLang, useLang } from "./useLang";

type Props = NativeStackScreenProps<RootStackParamList, "Dashboard">;

export function DashboardScreen({ navigation }: Props) {
  const lang = useLang();
  // Raw summary in state; cards derive at render so they follow the language.
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextSummary, dailyDigest] = await Promise.all([
        apiClient.getAnalyticsSummary(),
        apiClient.getDailyDigest().catch(() => null), // digest is best-effort
      ]);
      setSummary(nextSummary);
      setDigest(dailyDigest?.digest ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, "dashboard.loadFailed"));
    }
  }, [lang]);

  useEffect(() => {
    void load();
    // Kicked back to Login whenever the session drops (401 → signOut).
    return sessionStore.subscribe((session) => {
      if (!session) navigation.replace("Login");
    });
  }, [load, navigation]);

  const cards = summary ? dashboardCards(summary, lang) : [];
  const headerDirection = isRtl(lang) ? "row-reverse" : "row";

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
      <View
        style={{
          flexDirection: headerDirection,
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={common.title}>{t(lang, "dashboard.title")}</Text>
        <TouchableOpacity onPress={toggleLang} accessibilityRole="button">
          <Text style={common.subtle}>{lang === "en" ? "عربي" : "EN"}</Text>
        </TouchableOpacity>
      </View>
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
          <Text style={common.subtle}>{t(lang, "dashboard.dailyDigest")}</Text>
          <Text style={[common.text, { marginTop: 4, lineHeight: 21 }]}>{digest}</Text>
        </View>
      ) : null}

      {(
        [
          ["nav.approvals", "Approvals"],
          ["nav.stockLookup", "StockLookup"],
          ["nav.orders", "Orders"],
        ] as ReadonlyArray<readonly [MessageKey, "Approvals" | "StockLookup" | "Orders"]>
      ).map(([labelKey, route]) => (
        <TouchableOpacity
          key={route}
          style={common.button}
          onPress={() => navigation.navigate(route)}
        >
          <Text style={common.buttonText}>{t(lang, labelKey)}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity
        style={[common.button, { backgroundColor: colors.card, marginBottom: 32 }]}
        onPress={() => sessionStore.signOut()}
      >
        <Text style={[common.buttonText, { color: colors.subtle }]}>
          {t(lang, "dashboard.signOut")}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
