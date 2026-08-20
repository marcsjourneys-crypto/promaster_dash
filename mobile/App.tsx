import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AppSplash } from './src/screens/AppSplash';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { TripsScreen } from './src/screens/TripsScreen';
import { BLEScreen } from './src/screens/BLEScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AlertHistoryScreen } from './src/screens/AlertHistoryScreen';
import { DebugLogScreen } from './src/screens/DebugLogScreen';
import { loadSettings, saveSettings, type Settings, DEFAULT_SETTINGS } from './src/config/settings';
import { loadDisclaimerStatus, saveDisclaimerAccepted } from './src/config/legalConfig';
import { DisclaimerScreen } from './src/screens/DisclaimerScreen';
import { setEnabledPids } from './src/services/obdService';
import { seedDefaultSchedule, getScheduleWithStatus } from './src/services/maintenanceService';
import { MaintenanceScreen } from './src/screens/MaintenanceScreen';
import { CodesScreen } from './src/screens/CodesScreen';
import { initDatabase, seedDemoTrips, seedDemoMaintenance, clearDemoData } from './src/services/loggingService';
import { restoreTrip, tickWatchdog } from './src/services/tripManager';
import { makeUnits } from './src/utils/units';
import { useVehicleStore } from './src/store/vehicleStore';

type Screen = 'dashboard' | 'trips' | 'ble' | 'settings' | 'alerts' | 'debug' | 'maintenance' | 'codes';

let reminderShown = false;

export default function App() {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [liveMode, setLiveMode] = useState(true);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [dbReady, setDbReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  // null = still loading (splash visible); false = not accepted; true = accepted
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean | null>(null);
  const demoSeeded = useRef(false);

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

      // Check disclaimer before revealing the app — fail-safe returns false on error
      const { accepted } = await loadDisclaimerStatus();

      setSettings(s);
      setEnabledPids(s.enabledPids);
      setDisclaimerAccepted(accepted);
      setDbReady(true); // triggers splash to begin hiding

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

  // Seed demo data when demo mode activates; clear it when switching back to live.
  // demoSeeded ref tracks whether seeding actually ran (seed functions no-op if real
  // data exists) so we never accidentally wipe real trips on a live→demo→live cycle.
  useEffect(() => {
    if (!dbReady) return;
    if (!liveMode) {
      Promise.all([seedDemoTrips(), seedDemoMaintenance()])
        .then(([t, m]) => { if (t || m) demoSeeded.current = true; })
        .catch(() => {});
    } else if (demoSeeded.current) {
      demoSeeded.current = false;
      clearDemoData().catch(() => {});
    }
  }, [liveMode, dbReady]);

  // Display units — derived from settings, applied at render time only
  const units = useMemo(
    () => makeUnits({ tempUnit: settings.tempUnit, speedUnit: settings.speedUnit }),
    [settings.tempUnit, settings.speedUnit],
  );

  // Alert messages are built inside the store, so it needs the temperature unit
  useEffect(() => {
    useVehicleStore.getState().setTempUnit(settings.tempUnit);
  }, [settings.tempUnit]);

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

  const handleSetFocusActive = useCallback((active: boolean) => {
    setSettings((prev) => {
      const next = { ...prev, focusActive: active };
      saveSettings(next);
      return next;
    });
  }, []);

  const handleDisclaimerAccept = useCallback(async () => {
    await saveDisclaimerAccepted();
    setDisclaimerAccepted(true);
  }, []);

  return (
    <>
      <StatusBar style="light" />
      {!splashDone && (
        <AppSplash dbReady={dbReady} onReady={() => setSplashDone(true)} />
      )}
      {/* Disclaimer gate — blocks the entire app until accepted at current version */}
      {splashDone && disclaimerAccepted === false && (
        <DisclaimerScreen onAccept={handleDisclaimerAccept} />
      )}
      {/* Normal app — only rendered once disclaimer is accepted */}
      {splashDone && disclaimerAccepted === true && (
        <>
          {screen === 'dashboard' && (
            <DashboardScreen
              onNavigate={handleNavigate}
              useLiveGPS={liveMode}
              enabledPids={settings.enabledPids}
              units={units}
              focusPids={settings.focusPids}
              focusActive={settings.focusActive}
              onSetFocusActive={handleSetFocusActive}
            />
          )}
          {screen === 'trips' && (
            <TripsScreen onBack={() => setScreen('dashboard')} units={units} />
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
      )}
    </>
  );
}
