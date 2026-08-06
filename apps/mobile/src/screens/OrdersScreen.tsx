import { useCallback, useEffect, useState } from "react";
import { FlatList, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient } from "../lib/services";
import type { OrderDto, OrderStatus } from "../lib/api";
import { formatMinor } from "../lib/money";
import { colors, common } from "./theme";

type Props = NativeStackScreenProps<RootStackParamList, "Orders">;

const FILTERS = ["all", "pending", "confirmed", "fulfilled", "cancelled", "refunded"] as const;
type Filter = (typeof FILTERS)[number];

export function OrdersScreen(_props: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    setError(null);
    try {
      setOrders(await apiClient.listOrders(f === "all" ? undefined : (f as OrderStatus)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  return (
    <View style={common.screen}>
      <Text style={common.title}>Orders</Text>
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
              {f}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        ListEmptyComponent={<Text style={common.subtle}>No orders.</Text>}
        renderItem={({ item }) => (
          <View style={common.card}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={[common.text, { fontWeight: "700" }]}>{item.orderNo}</Text>
              <Text style={[common.text, { fontWeight: "700" }]}>
                {formatMinor(item.totalMinor, item.currency)}
              </Text>
            </View>
            <Text style={[common.subtle, { marginTop: 2 }]}>
              {item.status} · {item.channelKind} · {item.customerName ?? "walk-in"}
            </Text>
            <Text style={[common.subtle, { marginTop: 2 }]}>
              {new Date(item.placedAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai" })}
            </Text>
          </View>
        )}
      />
    </View>
  );
}
