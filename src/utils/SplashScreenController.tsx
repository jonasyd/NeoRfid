import { SplashScreen } from 'expo-router';
import React, { useEffect } from 'react';
import { useSession } from '@/context/SessionContext';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export function SplashScreenController() {
  const { isLoading } = useSession();
  useEffect(() => {
    if (!isLoading) SplashScreen.hideAsync().catch(() => undefined);
  }, [isLoading]);
  return null;
}
