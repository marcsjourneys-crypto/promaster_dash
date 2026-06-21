import React, { useState, useEffect, useCallback } from 'react';
import { Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AppSplash } from './src/screens/AppSplash';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { TripsScreen } from './src/screens/TripsScreen';
import { BLEScreen } from './src/screens/BLEScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AlertHistoryScreen } from './src/screens/AlertHistoryScreen';
import { DebugLogScreen } from './src/screens/DebugLogScreen';
import { loadSettings, type Settings, DEFAULT_SETTINGS } from './src/config/settings';
import { setEnabledPids } from './src/services/obdService';
import { seedDefaultSchedule, getScheduleWithStatus } from './src/services/maintenanceService';
import { MaintenanceScreen } from './src/screens/MaintenanceScreen';
import { CodesScreen } from './src/screens/CodesScreen';
import { initDatabase } from './src/services/loggingService';
import { restoreTrip, tickWatchdog } from './src/services/tripManager';

type Screen = 'dashboard' | 'trips' | 'ble' | 'settings' | 'alerts' | 'debug' | 'maintenance' | 'codes';

let reminderShown = false;

export default function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [liveMode, setLiveMode] = useState(true);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dbReady, setDbReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  // Load settings and DB on startup; coordinate for maintenance reminder
  useEffect(() => {
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;

    async function startup() {
      const [dbResult, settingsResult] = await Promise.allSettled([
        initDatabase().then(async (ok) => {
          if (ok) await restoreTrip().catch(() => {});
          return ok;
        }),
        loadSettings(),
      ]);

      const dbOk = dbResult.status === 'fulfilled' && dbResult.value;
      const s = settingsResult.status === 'fulfilled' ? settingsResult.value : DEFAULT_SETTINGS;

      setSettings(s);
      setEnabledPids(s.enabledPids);
      setDbReady(true);

      if (dbOk) {
        seedDefaultSchedule().catch(() => {});

        if (!reminderShown) {
          reminderShown = true;
          try {
            const schedule = await getScheduleWithStatus(s.severeDuty);
            const urgent = schedule.filter((r) => r.status === 'OVERDUE' || r.status === 'DUE SOON');
            if (urgent.length > 0) {
              Alert.alert(
                'Maintenance Due',
                urgent.map((r) => `• ${r.label} — ${r.status}`).join('\n'),
                [{ text: 'OK' }],
              );
            }
          } catch {}
        }
      }

      watchdogTimer = setInterval(tickWatchdog, 60_000);
    }

    startup();

    return () => {
      if (watchdogTimer) clearInterval(watchdogTimer);
    };
  }, []);

  const handleNavigate = useCallback((s: string) => {
    // Map any route to valid screens
    if (s === 'scan') s = 'codes'; // SCAN CODES → diagnostic codes screen
    setScreen(s as Screen);
  }, []);

  // When returning from settings, reload to pick up any changes
  const handleSettingsBack = useCallback(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setEnabledPids(s.enabledPids);
    });
    setScreen('dashboard');
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {!splashDone && (
        <AppSplash dbReady={dbReady} onReady={() => setSplashDone(true)} />
      )}
      {screen === 'dashboard' && (
        <DashboardScreen
          onNavigate={handleNavigate}
          useLiveGPS={liveMode}
          enabledPids={settings.enabledPids}
        />
      )}
      {screen === 'trips' && (
        <TripsScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'ble' && (
        <BLEScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'settings' && (
        <SettingsScreen
          onBack={handleSettingsBack}
          liveMode={liveMode}
          onLiveModeChange={setLiveMode}
          onNavigate={handleNavigate}
        />
      )}
      {screen === 'alerts' && (
        <AlertHistoryScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'debug' && (
        <DebugLogScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'codes' && (
        <CodesScreen onBack={() => setScreen('dashboard')} />
      )}
      {screen === 'maintenance' && (
        <MaintenanceScreen
          onBack={() => setScreen('dashboard')}
          severeDuty={settings.severeDuty}
          wizardComplete={settings.maintenanceWizardComplete}
          onWizardComplete={(duty) => {
            setSettings((prev) => ({ ...prev, severeDuty: duty, maintenanceWizardComplete: true }));
            loadSettings().then((s) => setSettings(s));
          }}
        />
      )}
    </>
  );
}
