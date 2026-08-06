import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../lib/navigation";
import { apiClient, sessionStore } from "../lib/services";
import { getApiBase, setApiBase } from "../lib/config";
import { isNetworkError } from "../lib/api";
import { t, type MessageKey } from "../lib/i18n";
import { colors, common } from "./theme";
import { toggleLang, useLang } from "./useLang";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const lang = useLang();
  const [apiBase, setApiBaseInput] = useState(getApiBase());
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Either a message key (rendered in the active language) or server prose.
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErrorKey(null);
    setErrorText(null);
    setApiBase(apiBase);
    try {
      const res = await apiClient.login({ slug: slug.trim(), email: email.trim(), password });
      sessionStore.signIn({ ...res, slug: slug.trim(), email: email.trim() });
      navigation.replace("Dashboard");
    } catch (err) {
      if (isNetworkError(err)) {
        setErrorKey("login.networkError");
      } else if (err instanceof Error && err.message) {
        setErrorText(err.message); // server's own explanation, passed through
      } else {
        setErrorKey("login.failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[common.screen, { justifyContent: "center" }]}>
      <TouchableOpacity
        onPress={toggleLang}
        style={{ alignSelf: "flex-end" }}
        accessibilityRole="button"
      >
        <Text style={common.subtle}>{lang === "en" ? "عربي" : "EN"}</Text>
      </TouchableOpacity>
      <Text style={common.title}>OmniRetail</Text>
      <Text style={[common.subtle, { marginBottom: 16 }]}>{t(lang, "login.subtitle")}</Text>
      {errorKey && <Text style={common.error}>{t(lang, errorKey)}</Text>}
      {errorText && <Text style={common.error}>{errorText}</Text>}
      <TextInput
        style={common.input}
        value={apiBase}
        onChangeText={setApiBaseInput}
        placeholder={t(lang, "login.apiPlaceholder")}
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={slug}
        onChangeText={setSlug}
        placeholder={t(lang, "login.slugPlaceholder")}
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={email}
        onChangeText={setEmail}
        placeholder={t(lang, "login.emailPlaceholder")}
        placeholderTextColor={colors.subtle}
        autoCapitalize="none"
        keyboardType="email-address"
        autoCorrect={false}
      />
      <TextInput
        style={common.input}
        value={password}
        onChangeText={setPassword}
        placeholder={t(lang, "login.passwordPlaceholder")}
        placeholderTextColor={colors.subtle}
        secureTextEntry
      />
      <TouchableOpacity style={common.button} onPress={() => void submit()} disabled={busy}>
        <Text style={common.buttonText}>
          {busy ? t(lang, "login.signingIn") : t(lang, "login.signIn")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
