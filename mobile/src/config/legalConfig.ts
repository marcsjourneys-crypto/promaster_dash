/** Legal copy, version tracking, and AsyncStorage helpers for the disclaimer gate. */

import AsyncStorage from '@react-native-async-storage/async-storage';

// Bump this number whenever the disclaimer text changes in a material way.
// Any user whose stored version is lower will be re-prompted on next launch.
export const DISCLAIMER_VERSION = 2;

export const DISCLAIMER_ACCEPTED_KEY = '@promaster/disclaimerAccepted';

// ---- URLs ---------------------------------------------------------------
// Replace PLACEHOLDER_URL with real URLs before App Store submission.

export const PRIVACY_POLICY_URL = 'https://promasterdash.com/privacy';

// ---- Disclaimer text ----------------------------------------------------
// Paste final legal copy here before App Store submission.
// This is the full body shown on the first-launch gate screen.

export const DISCLAIMER_TEXT = `END USER LICENSE AGREEMENT — ProMaster Dash

Effective date: June 23, 2026

This End User License Agreement ("Agreement") is a legal agreement between you ("you" or "User") and Marc Emmons ("Developer," "we," "us," or "our") governing your use of the ProMaster Dash mobile application and any related documentation and updates (the "App").

This Agreement is between you and Marc Emmons only, and not with Apple Inc. ("Apple"). Marc Emmons, not Apple, is solely responsible for the App and its content. By downloading, installing, or using the App, you agree to be bound by this Agreement. If you do not agree, do not download, install, or use the App.

1. License. Marc Emmons grants you a limited, non-exclusive, non-transferable, revocable license to use the App on any Apple-branded product that you own or control, as permitted by the Usage Rules set out in the Apple Media Services Terms and Conditions and the App Store Terms of Service. You may not distribute, redistribute, sublicense, sell, rent, lease, or make the App available over a network where it could be used by multiple devices at once, and you may not reverse engineer, decompile, or disassemble the App except to the extent that restriction is prohibited by law.

2. Informational Use Only; No Professional or Diagnostic Advice. The App is provided for general informational and educational purposes only. It is not a professional diagnostic tool and is not a substitute for inspection, diagnosis, or service by a qualified mechanic or for a professional-grade scan tool. Vehicle data displayed by the App, including but not limited to temperatures, pressures, speeds, voltages, and diagnostic trouble codes, may be inaccurate, incomplete, delayed, or unavailable, and may vary by vehicle, adapter, firmware, and operating conditions. You must not rely on the App for any safety-critical, mechanical, financial, or repair decision. Always verify with qualified professionals and appropriate equipment.

3. Diagnostic Trouble Codes. The App may allow you to read and, where supported by your vehicle and adapter, clear diagnostic trouble codes. Clearing codes is performed entirely at your own risk. Clearing codes can mask underlying vehicle faults, reset emissions readiness monitors, affect inspection or emissions test results, and remove information useful for diagnosis. You are solely responsible for understanding and accepting these consequences before clearing any code.

4. Safe Operation of Your Vehicle. You agree not to view, configure, or otherwise interact with the App while operating a vehicle. You are solely responsible at all times for the safe and lawful operation of your vehicle, for paying attention to the road, and for complying with all applicable laws. The App must not be allowed to distract you from operating your vehicle safely.

5. Disclaimer of Warranties. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE," WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND. MARC EMMONS DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. MARC EMMONS DOES NOT WARRANT THAT THE APP WILL BE UNINTERRUPTED, ERROR-FREE, ACCURATE, OR THAT ANY DATA IT DISPLAYS IS CORRECT.

6. Limitation of Liability. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL MARC EMMONS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, VEHICLE DAMAGE, REPAIR COSTS, DIMINISHED VALUE, FAILED INSPECTIONS, LOST PROFITS, OR LOSS OF USE, ARISING OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE APP, WHETHER BASED ON WARRANTY, CONTRACT, TORT, OR ANY OTHER LEGAL THEORY, EVEN IF MARC EMMONS HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL AGGREGATE LIABILITY OF MARC EMMONS FOR ALL CLAIMS RELATING TO THE APP WILL NOT EXCEED THE AMOUNT YOU ACTUALLY PAID FOR THE APP, OR FIVE U.S. DOLLARS (USD $5.00) IF YOU PAID NOTHING. Some jurisdictions do not allow certain limitations, so some of the above may not apply to you.

7. Indemnification. To the maximum extent permitted by applicable law, you agree to indemnify and hold harmless Marc Emmons from any claims, damages, losses, and expenses (including reasonable legal fees) arising out of your use of the App, your violation of this Agreement, or your violation of any law or the rights of any third party.

8. Maintenance and Support. Marc Emmons is solely responsible for providing any maintenance and support for the App as required by law or as Marc Emmons chooses to provide. Apple has no obligation whatsoever to provide any maintenance or support for the App. For questions or support, contact support@promasterdash.com.

9. Warranty Refund via Apple. In the event of any failure of the App to conform to any applicable warranty, you may notify Apple, and Apple may refund the purchase price (if any) for the App to you. To the maximum extent permitted by applicable law, Apple will have no other warranty obligation whatsoever with respect to the App, and any other claims, losses, liabilities, damages, costs, or expenses attributable to any failure to conform to any warranty will be Marc Emmons's sole responsibility.

10. Product Claims. Marc Emmons, not Apple, is responsible for addressing any claims by you or any third party relating to the App or your possession and use of it, including but not limited to product liability claims, any claim that the App fails to conform to any applicable legal or regulatory requirement, and claims arising under consumer protection, privacy, or similar legislation.

11. Intellectual Property. Marc Emmons retains all rights in the App not expressly granted to you. In the event of any third-party claim that the App or your use of it infringes that third party's intellectual property rights, Marc Emmons, not Apple, will be solely responsible for the investigation, defense, settlement, and discharge of any such claim.

12. Legal Compliance. You represent and warrant that you are not located in a country subject to a U.S. Government embargo or designated as a "terrorist supporting" country, and that you are not listed on any U.S. Government list of prohibited or restricted parties.

13. Third-Party Terms. You agree to comply with all applicable third-party terms when using the App.

14. Third-Party Beneficiary. You acknowledge and agree that Apple and Apple's subsidiaries are third-party beneficiaries of this Agreement, and that upon your acceptance, Apple will have the right (and will be deemed to have accepted the right) to enforce this Agreement against you as a third-party beneficiary.

15. Termination. This Agreement is effective until terminated. Your rights under it terminate automatically without notice if you fail to comply with any of its terms. Upon termination, you must stop using the App and delete all copies.

16. Governing Law. This Agreement is governed by the laws of the State of Washington, United States, without regard to its conflict-of-laws principles, except to the extent governed by U.S. federal law and except where prohibited by applicable law.

17. Entire Agreement; Severability. This Agreement is the entire agreement between you and Marc Emmons regarding the App and supersedes all prior understandings. If any provision is held unenforceable, the remaining provisions remain in full force.

Contact: Marc Emmons, support@promasterdash.com.`;

// ---- Clear-codes warning ------------------------------------------------
// Shown every time the user taps CLEAR CODES, independent of the disclaimer gate.
// Edit this string to adjust the wording without changing CodesScreen logic.

export const CLEAR_CODES_WARNING =
  'Clearing codes resets emissions readiness monitors and can hide active problems. ' +
  'Only clear codes after the underlying issue has been diagnosed and repaired. ' +
  'Proceed at your own risk.';

// ---- Storage helpers ----------------------------------------------------

interface DisclaimerRecord {
  version: number;
  acceptedAt: string; // ISO 8601
}

/**
 * Returns { accepted: true } if the stored record version matches or exceeds
 * DISCLAIMER_VERSION. Returns { accepted: false } on any read or parse failure
 * (fail-safe: missing or corrupt record always shows the gate).
 */
export async function loadDisclaimerStatus(): Promise<{ accepted: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(DISCLAIMER_ACCEPTED_KEY);
    if (!raw) return { accepted: false };
    const record = JSON.parse(raw) as DisclaimerRecord;
    return { accepted: record.version >= DISCLAIMER_VERSION };
  } catch {
    return { accepted: false };
  }
}

/** Persist acceptance at the current DISCLAIMER_VERSION with a timestamp. */
export async function saveDisclaimerAccepted(): Promise<void> {
  const record: DisclaimerRecord = {
    version: DISCLAIMER_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(DISCLAIMER_ACCEPTED_KEY, JSON.stringify(record));
}
