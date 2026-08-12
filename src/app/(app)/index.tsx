import { Redirect } from 'expo-router';
import React from 'react';
import { useSession } from '@/context/SessionContext';

export default function AppIndex() {
  const { session } = useSession();
  return <Redirect href={session?.depositoSeleccionado ? '/(app)/(tabs)' : '/(app)/deposito'} />;
}
