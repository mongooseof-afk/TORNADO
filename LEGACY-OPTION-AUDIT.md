# Old Launcher → new-site migration audit

Baseline: Launcher 1.8.34, the last release before the new-site adapter. 31 source files inventoried and JavaScript syntax parsed. 56 static Settings/Timing controls checked against the new helper.

This is a migration audit, not a claim of complete feature parity. Obfuscated legacy UI code was inventoried and parsed; it was not represented as a completed manual line-by-line proof. Modular handlers and their actual new-country bindings were reviewed. The original launcher layout and data managers remain; showing a legacy control alone does not connect it to the new website.

Current priority fixed: the new worker authorizes the current Chrome tab route after SPA login, rather than classifying the page using the content script document's original URL. Successful Login → My Account → Book Appointment is tested in captured React Chrome fixtures for Morocco and Mauritania, without reloading My Account.

Statuses: ready = connected new behavior; equivalent = changed-site counterpart; partial = some behavior exists; pending = not ported; native = stays with native verification/site UI.

| Old control | Status | New-site behavior / remaining work | Legacy source |
|---|---|---|---|
| Submit Slot | pending | Manual Submit Slot needs a new-protocol launcher command and a native selected-slot guard. Automatic submission already exists. | src/slot-actions-ui.js:4 |
| Go Login | ready | Go Login is routed to /login for the selected country. | src/index.js |
| Start New App | equivalent | New App is available in the toolbar and Retry; the separate launcher button was removed at the earlier user request. | src/index.js |
| Relogin | pending | Old logout/re-login semantics need a new native authentication lifecycle adapter. | src/index.js |
| Change Proxy | partial | Validated proxies are supported through On Max Attempts; the separate bulk manual button is not connected to the new helper. Security verification never triggers proxy rotation. | src/ProxyManager.js |
| Change IP | pending | Old provider-specific Change IP command is not connected to the new helper. It must not be used to bypass security verification. | src/ProxyManager.js |
| Super Refresh | pending | Legacy refresh is MONGOOSE_SLOT_ACTION refresh. New-site SPA booking/liveness guards require adaptation before exposing it. | src/slot-actions-ui.js:2 |
| Change Days | pending | Legacy change-day command; needs a native new-calendar adapter. | src/slot-actions-ui.js:2 |
| Clear Days | pending | Legacy clear-days command; the new React calendar has different selection state. | src/slot-actions-ui.js:2 |
| Submit Visatype | equivalent | The new site has no old VisaType page. Auto Book Appointment covers the pre-calendar native flow; old stop-toggle semantics are not identical. | src/slot-actions-ui.js:2 |
| Submit Pre Slot | ready | Submit Pre Slot opens the current-country Retry route. | src/slot-actions-ui.js:2 |
| Reload Session | pending | Requires stage-aware login navigation excluding calendar, verification and payment, which share SPA URLs. | src/slot-actions-ui.js:2 |
| Auto Login | ready | Native login form filling, selected account persistence and successful SPA login-to-account regression tested. | src/index.js |
| Auto Captcha | native | The new portal keeps its native verification. The old numeric-image solver is not a replacement for new-site verification. | src/ocr_captchaai.js |
| Auto Visa Type | equivalent | Auto Book Appointment: native primary applicant / Individual flow. Family automation is not complete. | src/index.js |
| Auto Submit Slot | ready | Auto Submit Calendar uses native available date, earliest time and one confirmation. Random/First/Last date modes. | src/index.js |
| Auto Retry Calendar | ready | Auto Retry Calendar and configurable Delay; blank Delay holds. | src/index.js |
| Auto Retry Calendar /Sec | equivalent | Delay in seconds covers interval retries; old separate Sec toggle is not exposed. Exact-second targeting is a separate pending feature. | src/index.js |
| Auto Proxy Rotation | partial | Only the explicit On Max Attempts proxy action is implemented for the new helper. | src/index.js |
| Auto Reload Error Occurred | partial | Calendar transient failures already back off. The separate old generic-page switch/delay has not been ported. | src/tornado-error-reload-ui.js:37 |
| Auto Reload Site Errors | partial | New Retry respects transient errors, 401/403 and 429. Broad page/POST automatic reloading is not ported. | src/site-error-main.js |
| Minute Distribution | pending | The old minute-divider accepts Spain/Portugal and TORNADO_MINUTE messages; new channels need readiness, scheduling and cancel integration. | src/minute-divider.js |
| Signal Submit - Calendrie | pending | New helper needs a native manual-submit command for the launcher signal. | src/index.js |
| Signal Submit - Retry Calendrie | pending | Local manual Retry exists; the legacy bulk signal is not integrated. | src/index.js |
| Signal Submit - Visatype | equivalent | No old VisaType route exists; equivalent action needs explicit new booking semantics. | src/index.js |
| Signal Alert 🔔 | pending | Legacy alert sound/notification requires a new available-slots notification adapter. | src/index.js |
| Dark Mode Launcher | ready | The original launcher theme switch is now visible under Secondary for both new countries. | src/index.js |
| Recaptcha Token | native | Do not replay old tokens into the new verification system. New-site verification remains controlled by the website. | src/recaptcha-settings-main.js |
|  | native | Old token refresh behavior does not map to a documented new-site action. | src/recaptcha-settings-main.js |
| Center | ready | Advanced Centre criterion, checked against the saved applicant; Mauritania only Nouadhibou. Applicant edits remain manual. | src/index.js |
| Visa Type | ready | Advanced Visa Type criterion, checked against saved applicant. | src/index.js |
| Category | native | Removed at the earlier user request; appointment type/category remains a native calendar choice. | src/index.js |
| Members | partial | Advanced member count is saved; automatic Individual uses one primary applicant. Family selection remains manual. | src/index.js |
| Update | ready | Advanced Update saves scoped Centre/Visa Type/Members criteria. | src/index.js |
| On Max Attempts : | ready | Stop/New App/Switch Proxy, once per reached limit, after server cooldown. | src/index.js |
| Proxy From : | partial | Uses valid proxies supplied by Manage > Proxy. Separate old source selector is not migrated. | src/ProxyManager.js |
| Delay (seconds) : | ready | Delay seconds 1–120 or empty; empty disables automatic calendar requests. | src/index.js |
| Attemps (value) : | ready | Attempt limit remains in Launcher; deliberately removed from Retry panel. | src/index.js |
| Delay Reload Error Occurred (seconds) : | pending | Separate old Error Occurred delay is not connected to the new helper. | src/tornado-error-reload-ui.js:37 |
| Auto Refresh On Errors (seconds) : | pending | Separate old site error refresh delay is not connected to the new helper. | src/site-error-main.js |
| start-time | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| delay in ms | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Set | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Stop | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js:620 |
| start-time-r | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| delay in ms | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Set | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Stop | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js:643 |
| start-time-action | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| delay in ms | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Set | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Stop | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js:636 |
| start-time-relogin | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| delay in ms | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Set | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js |
| Stop | pending | Legacy scheduler needs a new-country command adapter and stage/clock/cancellation tests. | src/main.js:643 |

Additional module review: account/client/proxy CRUD/import/export remain in the original launcher manager with isolated account/client buckets. The old duplicate-email guard remains. Auto OTP/Gmail and selfie/server handoff use legacy message contracts and are not declared migrated to the new post-calendar flow. Native new-site verification is not bypassed. The GMT widget matches the legacy device-clock UTC formatting, HH:MM:SS.mmm, and is displayed on all new-site pages; it is not BLS server time.

Next work after calendar acceptance: native manual calendar/day actions and signals; stage-aware session/relogin/error settings; scheduler/minute distribution; then post-calendar OTP and selfie/payment handoff with native-flow evidence. Confirmed appointments stay protected.
