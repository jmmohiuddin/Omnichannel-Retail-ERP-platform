/** Shared dark-friendly palette + common styles for the thin screen layer. */
import { StyleSheet } from "react-native";

export const colors = {
  bg: "#0f1216",
  card: "#1a1f26",
  border: "#2a3038",
  text: "#e8ecf1",
  subtle: "#8b95a1",
  accent: "#4da3ff",
  positive: "#3ecf8e",
  negative: "#ff6b6b",
} as const;

export const common = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 16,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 12,
  },
  text: {
    color: colors.text,
    fontSize: 15,
  },
  subtle: {
    color: colors.subtle,
    fontSize: 13,
  },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    fontSize: 15,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: {
    color: "#0b1016",
    fontSize: 16,
    fontWeight: "700",
  },
  error: {
    color: colors.negative,
    marginBottom: 10,
  },
});
