import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SessionProvider, useSession } from '@/context/SessionContext';
import { SplashScreenController } from '@/utils/SplashScreenController';

export default function RootLayout() {
  return (
    <SessionProvider>
      {/* Las pantallas tienen fondo claro: sin esto, Android dibuja la hora y los iconos de
          estado en blanco y quedan ilegibles. "dark" los pinta en negro. */}
      <StatusBar style="dark" />
      <SplashScreenController />
      <RootNavigator />
    </SessionProvider>
  );
}

function RootNavigator() {
  const { isAuthenticated, isLoading } = useSession();

  if (isLoading) {
    return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator /></View>;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}
