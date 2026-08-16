import { Redirect } from 'expo-router';
import React from 'react';

export default function AppIndex() {
  return <Redirect href="/(app)/(tabs)" />;
}
