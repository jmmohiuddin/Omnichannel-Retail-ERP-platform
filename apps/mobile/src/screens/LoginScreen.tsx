import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient, sessionStore } from "../lib/services";
import { getApiBase, setApiBase } from "../lib/config";
import { isNetworkError } from "../lib/api";
import { colors, common } from "./theme";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const [apiBase, setApiBaseInput] = useState(getApiBase());
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setApiBase(apiBase);
    try {
      const res = await apiClient.login({ slug: slug.trim(), email: email.trim(), password });
      sessionStore.signIn({ ...res, slug: slug.trim(), email: email.trim() });
      navigation.replace("Dashboard");
    } catch (err) {
      setError(
        isNetworkError(err)
          ? "Cannot reach the API — check the server address (use your machine's LAN IP)."
          : err instanceof Error
            ? err.message
            : "Sign-in failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[common.screen, { justifyContent: "center" }]}>
      <Text style={common.title}>OmniRetail</Text>
      <Text style={[common.subtle, { marginBottom: 16 }]}>Owner / manager companion</Text>
      {error && <Text style={common.error}>{error}</Text>}
      <TextInput
        style={common.input}
        value={apiBase}
        onChangeText={setApiBaseInput}
        placeholder="API server (http://192.168.x.x:3001)"
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={slug}
        onChangeText={setSlug}
        placeholder="Store slug"
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        keyboardType="email-address"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={colors.subtle}
        secureTextEntry
      />
      <TouchableOpacity style={common.button} onPress={() => void submit()} disabled={busy}>
        <Text style={common.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
      </TouchableOpacity>
    </View>
  );
}
