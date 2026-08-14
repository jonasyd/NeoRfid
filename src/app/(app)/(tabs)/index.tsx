import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';

export default function HomeScreen() {
  const { session } = useSession();
  return (
    <Screen noPadding>
      <View style={styles.container}>
        <Image
          source={require('../../../../assets/welcome.png')}
          style={styles.backgroundImage}
          resizeMode="cover"
        />
        <View style={styles.overlay}>
          <Text style={styles.title}>¡Bienvenido{session?.username ? `, ${session.username}` : ''}!</Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backgroundImage: { ...StyleSheet.absoluteFill, width: '100%', height: '100%' },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(2, 36, 73, 0.45)'
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 12,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10
  },
});
