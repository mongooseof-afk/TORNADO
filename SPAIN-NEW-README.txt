# Tornado Launcher 1.8.53 / Morocco and Mauritania helpers 2.0.18

Close the old Launcher, open Launcher 1.8.53, update the matching extension to 2.0.18 from its dist/ folder, and reload existing portal tabs once. Launcher and helper must be updated together. Country account keys and extension identities are preserved.

Options are named Auto Retry Calendar /Sec and Auto Retry Calendar.

- Auto Retry Calendar uses the Delay (seconds) configured in Others. It can stay ON with a blank Delay and sends no automatic request until a Delay is provided. Clearing Delay cancels the pending interval.
- Auto Retry Calendar /Sec can stay ON with no time configured. It does not force a tab change or require a value to enable. With no time, no scheduled tick or automatic request is created. In Timing, set the full device-local time and profile delay, then press Set to start at that time and repeat each minute. Clearing the time and pressing Set leaves the option ON but idle. A newly set past time starts tomorrow, as before.
- The existing mode exclusion is retained: enabling one mode stops the other. With both OFF, the native-gated Retry screen stays visible and shows Disabled, with no automatic interval or timed request. Manual Redirect Now and Retry all remain available.

Timing keeps the requested legacy Retry Calendar Scheduler /delay card, with side-by-side time and profile spacing inputs, green Set, and red Stop. Invalid entered values are still rejected; blank values are valid. Stop cancels queued scheduled sends.

Removed the Launcher operational command notices, including checked/skipped/failed summaries and their Retry-all log entries. Removed the extension's booking-step banners such as Individual appointment selected, transient automatic cancellation notices, empty-draft toast, and calendar HTTP-success notices. Functional Retry state, the login/account controls, manual draft-selection UI, and native website messages remain available.

Validation: 12 standalone tests passed per helper; real Electron UI/preload/IPC tests passed for both countries including enabled-idle, empty-time persistence, clear-time cancellation, OFF/ON without reload, mode exclusion, Stop and reload restore. DOM fixtures verified blank Delay, configured Delay, clearing Delay, both OFF, pending cancellation, popup empty-time activation and manual Retry. Actual Chrome helper fixtures with two profiles/four Retry tabs per country verified scheduled ticks, empty-time silence, profile spacing, Stop, headers, country/session/verification/cooldown guards and no document reload. Captured React fixtures completed booking to native no-slots with zero added booking-step banners. All site responses were intercepted and synthetic; no live BLS booking or cancellation was performed. Applicant-selection to liveness, APK and Gmail changes are not included in this release.
