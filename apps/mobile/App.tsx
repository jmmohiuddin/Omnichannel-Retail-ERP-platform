import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import type { RootStackParamList } from "./src/lib/navigation";
import { LoginScreen } from "./src/screens/LoginScreen";
import { DashboardScreen } from "./src/screens/DashboardScreen";
import { ApprovalsScreen } from "./src/screens/ApprovalsScreen";
import { StockLookupScreen } from "./src/screens/StockLookupScreen";
import { OrdersScreen } from "./src/screens/OrdersScreen";
import { colors } from "./src/screens/theme";

const Stack = createNativeStackNavigator<RootStackParamList>();

const screenOptions = {
  headerStyle: { backgroundColor: colors.bg },
  headerTintColor: colors.text,
  contentStyle: { backgroundColor: colors.bg },
} as const;

export default function App() {
  return (
    <NavigationContainer theme={DarkTheme}>
      <StatusBar style="light" />
      <Stack.Navigator initialRouteName="Login" screenOptions={screenOptions}>
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen name="Approvals" component={ApprovalsScreen} options={{ title: "" }} />
        <Stack.Screen name="StockLookup" component={StockLookupScreen} options={{ title: "" }} />
        <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: "" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
