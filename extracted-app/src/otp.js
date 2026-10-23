/**
 * ThunderBolt 1.8.5 — Automated Email OTP Retriever (Deobfuscated & Cleaned)
 * Connects to IMAP (imap.gmail.com) using credentials (email + app password)
 * Searches for BLS Visa Appointment OTP emails and extracts the 6-digit verification code.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const BLS_SUBJECT_PATTERNS = [
  'BLS Visa Appointment - Email Verification',
  'BLS Visa Appointment - User Verification'
];

/**
 * Connect to IMAP and inspect recent emails for BLS verification codes
 */
async function checkAllBLSEmails(email, appPassword) {
  const result = {
    success: false,
    found: false,
    totalChecked: 0,
    blsEmails: [],
    allEmails: [],
    errors: []
  };

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      pass: appPassword
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Search for unread / recent messages
      const uids = await client.search({ seen: false });
      result.totalChecked = uids.length;

      if (uids.length === 0) {
        result.success = true;
        result.message = 'No unread emails found';
        return result;
      }

      // Sort descending (newest first)
      uids.sort((a, b) => b - a);

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true });
          const parsed = await simpleParser(msg.source);
          const body = parsed.text || parsed.html || '';
          const subject = parsed.subject || '';

          const emailItem = {
            uid,
            subject,
            from: parsed.from?.text || 'Unknown',
            to: parsed.to?.text || 'Unknown',
            date: parsed.date || new Date(),
            body,
            bodyPreview: body.substring(0, 500),
            messageId: parsed.messageId,
            isBLS: false,
            otp: null,
            email: null,
            subjectMatched: null
          };

          const matchedPattern = BLS_SUBJECT_PATTERNS.find(pattern =>
            subject.toLowerCase().includes(pattern.toLowerCase())
          );

          if (matchedPattern) {
            const otpMatch = body.match(/\b\d{6}\b/);
            emailItem.otp = otpMatch ? otpMatch[0] : null;

            const emailMatch = body.match(/^Dear\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/mi);
            emailItem.email = emailMatch ? emailMatch[1] : null;

            emailItem.isBLS = true;
            emailItem.subjectMatched = matchedPattern;

            result.blsEmails.push(emailItem);
            result.found = true;
          }

          // Mark as seen
          await client.messageFlagsAdd(uid, ['\\Seen']);
          result.allEmails.push(emailItem);
        } catch (fetchErr) {
          result.errors.push({
            uid,
            error: fetchErr.message
          });
        }
      }

      result.success = true;
      return result;
    } finally {
      lock.release();
    }
  } catch (err) {
    result.success = false;
    result.error = err.message;
    return result;
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

/**
 * Retrieve all BLS OTPs for a given account
 */
async function getAllBLSOTPs(email, appPassword) {
  const res = await checkAllBLSEmails(email, appPassword);
  if (res.success) {
    const otps = res.blsEmails
      .filter(item => item.otp)
      .map(item => ({
        otp: item.otp,
        email: item.email,
        from: item.from,
        subject: item.subject,
        subjectMatched: item.subjectMatched,
        uid: item.uid,
        date: item.date
      }));

    return {
      success: true,
      found: otps.length > 0,
      otps,
      totalChecked: res.totalChecked,
      totalBLS: res.blsEmails.length,
      message: otps.length > 0
        ? `Found ${otps.length} OTP(s)`
        : res.blsEmails.length > 0
          ? 'Found BLS emails but no OTPs'
          : 'No BLS emails found'
    };
  } else {
    return {
      success: false,
      found: false,
      error: res.error || 'Failed to check emails'
    };
  }
}

/**
 * Retrieve the latest single BLS OTP for a given account
 */
async function getLatestBLS(email, appPassword) {
  const res = await checkAllBLSEmails(email, appPassword);
  if (res.success && res.blsEmails.length > 0) {
    const first = res.blsEmails[0];
    return {
      success: true,
      found: true,
      otp: first.otp,
      email: first.email,
      from: first.from,
      subject: first.subject,
      subjectMatched: first.subjectMatched,
      uid: first.uid,
      date: first.date,
      totalBLSFound: res.blsEmails.length
    };
  } else {
    return {
      success: false,
      found: false,
      message: res.message || 'No BLS emails found'
    };
  }
}

module.exports = {
  checkAllBLSEmails,
  getAllBLSOTPs,
  getLatestBLS
};