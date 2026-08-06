import { useCallback, useEffect, useState } from "react";
import { FlatList, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient } from "../lib/services";
import type { OrderDto, OrderStatus } from "../lib/api";
import { isRtl, t, type MessageKey } from "../lib/i18n";
import { formatMinor } from "../lib/money";
import { colors, common } from "./theme";
import { useLang } from "./useLang";

type Props = NativeStackScreenProps<RootStackParamList, "Orders">;

const FILTERS = ["all", "pending", "confirmed", "fulfilled", "cancelled", "refunded"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, MessageKey> = {
  all: "orders.filter.all",
  pending: "orders.filter.pending",
  confirmed: "orders.filter.confirmed",
  fulfilled: "orders.filter.fulfilled",
  cancelled: "orders.filter.cancelled",
  refunded: "orders.filter.refunded",
};

export function OrdersScreen(_props: Props) {
  const lang = useLang();
  const [filter, setFilter] = useState<Filter>("all");
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: Filter) => {
      setError(null);
      try {
        setOrders(await apiClient.listOrders(f === "all" ? undefined : (f as OrderStatus)));
      } catch (err) {
        setError(err instanceof Error ? err.message : t(lang, "orders.loadFailed"));
      }
    },
    [lang],
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // Inline flip only — full native RTL via I18nManager needs an app reload.
  const rowDirection = isRtl(lang) ? "row-reverse" : "row";

  return (
    <View style={common.screen}>
      <Text style={common.title}>{t(lang, "orders.title")}</Text>
      {error && <Text style={common.error}>{error}</Text>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            style={{
              backgroundColor: f === filter ? colors.accent : colors.card,
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 7,
              marginRight: 8,
            }}
          >
            <Text style={{ color: f === filter ? "#0b1016" : colors.subtle, fontWeight: "600" }}>
              {t(lang, FILTER_LABELS[f])}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        ListEmptyComponent={<Text style={common.subtle}>{t(lang, "orders.empty")}</Text>}
        renderItem={({ item }) => (
          <View style={common.card}>
            <View style={{ flexDirection: rowDirection, justifyContent: "space-between" }}>
              <Text style={[common.text, { fontWeight: "700" }]}>{item.orderNo}</Text>
              <Text style={[common.text, { fontWeight: "700" }]}>
                {formatMinor(item.totalMinor, item.currency)}
              </Text>
            </View>
            <Text style={[common.subtle, { marginTop: 2 }]}>
              {item.status} · {item.channelKind} · {item.customerName ?? t(lang, "orders.walkIn")}
            </Text>
            <Text style={[common.subtle, { marginTop: 2 }]}>
              {/* en-AE date formatting keeps Western numerals in both languages. */}
              {new Date(item.placedAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai" })}
            </Text>
          </View>
        )}
      />
    </View>
  );
}
