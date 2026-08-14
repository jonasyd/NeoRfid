import React, { PropsWithChildren } from 'react';
import { SafeAreaView, StyleSheet, View, ViewStyle } from 'react-native';

interface ScreenProps extends PropsWithChildren {
  style?: ViewStyle;
  noPadding?: boolean;
}

export function Screen({ children, style, noPadding }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.container, noPadding && { padding: 0 }, style]}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f7f8fa' },
  container: { flex: 1, padding: 16 },
});
