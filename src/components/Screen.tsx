import React, { PropsWithChildren } from 'react';
import { SafeAreaView, StyleSheet, View } from 'react-native';

export function Screen({ children }: PropsWithChildren) {
  return <SafeAreaView style={styles.safe}><View style={styles.container}>{children}</View></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f8fa' },
  container: { flex: 1, padding: 16 },
});
