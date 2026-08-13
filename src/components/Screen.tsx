import React, { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function Screen({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();

  // Rule of 8dp spacing:
  // Apply a minimum padding of 16dp (2 * 8) plus safe area insets to avoid overlapping
  // with top status bar or bottom OS navigation indicators.
  const paddingTop = Math.max(16, Math.ceil(insets.top / 8) * 8);
  const paddingBottom = Math.max(16, Math.ceil(insets.bottom / 8) * 8);
  const paddingLeft = Math.max(16, Math.ceil(insets.left / 8) * 8);
  const paddingRight = Math.max(16, Math.ceil(insets.right / 8) * 8);

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop,
          paddingBottom,
          paddingLeft,
          paddingRight
        }
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7f8fa'
  },
});
