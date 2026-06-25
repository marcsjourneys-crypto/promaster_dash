/** First-launch legal disclaimer gate — must be accepted before entering the app. */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Linking,
  SafeAreaView,
} from 'react-native';
import { colors, fonts } from '../config/theme';
import {
  DISCLAIMER_TEXT,
  PRIVACY_POLICY_URL,
} from '../config/legalConfig';

interface Props {
  onAccept: () => void;
}

export function DisclaimerScreen({ onAccept }: Props) {
  const [declined, setDeclined] = useState(false);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appName}>ProMaster Dash</Text>
        <Text style={styles.subtitle}>Legal Disclaimer</Text>
      </View>

      {/* Scrollable body */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <Text style={styles.body}>{DISCLAIMER_TEXT}</Text>

        <View style={styles.linksRow}>
          <Pressable onPress={() => Linking.openURL(PRIVACY_POLICY_URL).catch(() => {})}>
            <Text style={styles.link}>Privacy Policy</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Footer actions */}
      <View style={styles.footer}>
        {declined && (
          <Text style={styles.declineMsg}>
            You must accept to use ProMaster Dash.
          </Text>
        )}

        <Pressable style={styles.agreeBtn} onPress={onAccept}>
          <Text style={styles.agreeBtnText}>I UNDERSTAND AND AGREE</Text>
        </Pressable>

        <Pressable style={styles.declineBtn} onPress={() => setDeclined(true)}>
          <Text style={styles.declineBtnText}>DECLINE</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },
  appName: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
    letterSpacing: 1,
  },
  subtitle: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 24,
    paddingBottom: 32,
  },
  body: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
    lineHeight: 22,
  },
  linksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
  },
  link: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  linkSep: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.amberBorder,
    gap: 10,
  },
  declineMsg: {
    color: 'rgba(220, 80, 60, 0.9)',
    fontSize: fonts.sizeSm,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  agreeBtn: {
    backgroundColor: 'rgba(220, 140, 35, 0.15)',
    borderWidth: 2,
    borderColor: colors.amber,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  agreeBtnText: {
    color: colors.amber,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
    letterSpacing: 1,
  },
  declineBtn: {
    borderWidth: 1,
    borderColor: 'rgba(180, 35, 25, 0.4)',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  declineBtnText: {
    color: 'rgba(220, 80, 60, 0.7)',
    fontSize: fonts.sizeSm,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
