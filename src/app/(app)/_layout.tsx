import { Redirect, Stack } from 'expo-router';
import React from 'react';
import { useSession } from '@/context/SessionContext';

export default function AppLayout() {
  const { session } = useSession();
  if (!session?.depositoSeleccionado && session?.depositos?.length) {
    return <Redirect href="/(app)/deposito" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
