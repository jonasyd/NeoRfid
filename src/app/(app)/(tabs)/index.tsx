import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSession } from '@/context/SessionContext';

export default function HomeScreen() {
  const { session } = useSession();
  return (
    <Screen>
      <View style={styles.center}>
        <Image source={require('../../../../assets/welcome.png')} style={styles.image} resizeMode="contain" />
        <Text style={styles.title}>¡Bienvenido{session?.username ? `, ${session.username}` : ''}!</Text>
        <Text style={styles.subtitle}>{session?.depositoSeleccionado?.nombre ?? 'Seleccioná un depósito'}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '90%', height: 260 },
  title: { fontSize: 25, fontWeight: '700', color: '#101828', marginTop: 12 },
  subtitle: { color: '#667085', marginTop: 6 },
});
