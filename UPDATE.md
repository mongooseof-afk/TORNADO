# Tornado 1.8.55 / Extensions 2.0.22

The classic Add/Edit Account form remains the source of name, email, password and App Password (Gmail). The separate Auto Code · Gmail card has been removed. Save a valid Gmail App Password in the existing account field to enable OTP reading for that account. Clearing the field disables it. The mailbox username is the saved account email, as in the old Launcher; non-Gmail mailboxes require their own integration. Existing account storage/export behavior is preserved. The local reader uses an encrypted copy and never sends the App Password to the extension.

Manage > Clients now has an Import client pictures icon beside the existing Import/Export buttons. The separate Client Photos card has been removed. Choose JPEG/PNG pictures below 1 MB. Matching passport/name filenames select the client automatically; otherwise select the client in the import dialog. Export Clients includes saved pictures as optional tornadoPhoto fields in the existing JSON array. The original Import Clients button restores them; image bytes stay out of localStorage. Existing client files without pictures still work.

The compact Tornado photo picker appears only at the native applicant photo-upload step. Double-click a photo to fill the site's ordinary file input. A hidden webcam video no longer hides the picker; an active visible camera does. This is a file upload helper, not a liveness or camera substitute.

Load the matching extension dist folder and run Launcher 1.8.55. Morocco and Mauritania retain separate stores.

Validation: native Electron tests passed for both countries (classic account App Password synchronization, picture import, client/photo export and reimport, no image data in localStorage, existing Timing settings); Chromium fixtures passed for double-click upload, hidden video, OTP input, duplicate prevention and SPA routes; 24 existing tests passed. No live mailbox or live BLS booking was used.

User preference for future updates: inspect and preserve the old design and logic whenever the feature already exists.
