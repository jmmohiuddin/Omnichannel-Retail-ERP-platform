import { useEffect, useState } from "react";
import { FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient } from "../lib/services";
import type { AvailabilityDto, LocationDto } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { stockSearchResults, type StockSearchRow } from "../lib/viewmodels";
import { colors, common } from "./theme";
import { useLang } from "./useLang";

type Props = NativeStackScreenProps<RootStackParamList, "StockLookup">;

interface LocationAvailability {
  location: LocationDto;
  availability: AvailabilityDto | null;
}

export function StockLookupScreen(_props: Props) {
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<StockSearchRow[]>([]);
  const [locations, setLocations] = useState<LocationDto[]>([]);
  const [selected, setSelected] = useState<StockSearchRow | null>(null);
  const [perLocation, setPerLocation] = useState<LocationAvailability[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .listLocations()
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  async function search() {
    setError(null);
    setSelected(null);
    try {
      setRows(stockSearchResults(await apiClient.searchProducts(query.trim())));
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, "stock.searchFailed"));
    }
  }

  async function showAvailability(row: StockSearchRow) {
    setSelected(row);
    setError(null);
    try {
      const results = await Promise.all(
        locations.map(async (location) => ({
          location,
          availability: await apiClient
            .getAvailability(row.variantId, location.id)
            .catch(() => null),
        })),
      );
      setPerLocation(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(lang, "stock.availabilityFailed"));
    }
  }

  // Direction-aware chevron; full native RTL (I18nManager) is a reload-time step.
  const backChevron = isRtl(lang) ? "›" : "‹";

  return (
    <View style={common.screen}>
      <Text style={common.title}>{t(lang, "stock.title")}</Text>
      {error && <Text style={common.error}>{error}</Text>}
      <TextInput
        style={common.input}
        value={query}
        onChangeText={setQuery}
        placeholder={t(lang, "stock.searchPlaceholder")}
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={() => void search()}
      />

      {selected ? (
        <View>
          <TouchableOpacity onPress={() => setSelected(null)}>
            <Text style={[common.subtle, { marginBottom: 8 }]}>
              {backChevron} {t(lang, "stock.backToResults")}
            </Text>
          </TouchableOpacity>
          <View style={common.card}>
            <Text style={[common.text, { fontWeight: "700" }]}>{selected.productName}</Text>
            <Text style={common.subtle}>
              {selected.sku} · {selected.price} · {selected.tracking}
            </Text>
          </View>
          {perLocation.map(({ location, availability }) => (
            <View key={location.id} style={common.card}>
              <Text style={[common.text, { fontWeight: "700" }]}>{location.name}</Text>
              {availability ? (
                <Text style={[common.subtle, { marginTop: 2 }]}>
                  {t(lang, "stock.availabilityLine", {
                    available: availability.available,
                    onHand: availability.onHand,
                    reserved: availability.reserved,
                    inTransit: availability.inTransit,
                  })}
                </Text>
              ) : (
                <Text style={[common.subtle, { marginTop: 2 }]}>{t(lang, "stock.noData")}</Text>
              )}
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.variantId}
          ListEmptyComponent={<Text style={common.subtle}>{t(lang, "stock.searchHint")}</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={common.card} onPress={() => void showAvailability(item)}>
              <Text style={[common.text, { fontWeight: "700" }]}>{item.productName}</Text>
              <Text style={[common.subtle, { marginTop: 2 }]}>
                {item.sku} · {item.price}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}
