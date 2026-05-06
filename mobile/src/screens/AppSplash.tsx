import React, { useEffect, useRef } from 'react';
import { View, Image, Animated, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native';
import { colors, fonts } from '../config/theme';

interface Props {
  onReady: () => void;
  dbReady: boolean;
}

const MIN_DISPLAY_MS = 1800;

export function AppSplash({ onReady, dbReady }: Props) {
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.75)).current;
  const tagOpacity = useRef(new Animated.Value(0)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  const minElapsed = useRef(false);
  const dbIsReady = useRef(false);

  function tryComplete() {
    if (!minElapsed.current || !dbIsReady.current) return;
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 350,
      useNativeDriver: true,
    }).start(() => onReady());
  }

  useEffect(() => {
    // Animate logo in
    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.spring(logoScale, {
          toValue: 1,
          tension: 60,
          friction: 8,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(tagOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
    ]).start();

    // Enforce minimum display time
    const t = setTimeout(() => {
      minElapsed.current = true;
      tryComplete();
    }, MIN_DISPLAY_MS);

    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (dbReady) {
      dbIsReady.current = true;
      tryComplete();
    }
  }, [dbReady]);

  return (
    <Animated.View style={[styles.container, { opacity: screenOpacity }]}>
      <SafeAreaView style={styles.inner}>
        <Animated.Image
          source={require('../../assets/PD.png')}
          style={[styles.logo, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}
          resizeMode="contain"
        />
        <Animated.Text style={[styles.tagline, { opacity: tagOpacity }]}>
          PROMASTER DASH
        </Animated.Text>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
    zIndex: 999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
  },
  logo: {
    width: 180,
    height: 180,
  },
  tagline: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 4,
  },
});
