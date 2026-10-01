/**
 * MASTER FILES — ACTS email automation (server-side, never from the browser).
 *
 * Requires: Firebase Blaze plan, and the "Trigger Email from Firestore" extension
 * installed with its collection set to "mail" (it sends whatever is written there).
 * Neither function contains an email address: RC ACTS recipients are looked up
 * from admins/{uid} (role RC_ACTS, status ACTIVE) and their Firebase Auth email.
 */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const TZ = "Africa/Johannesburg";

async function rcActsEmails() {
  const snap = await db.collection("admins")
    .where("role", "array-contains", "RC_ACTS")
    .where("status", "==", "ACTIVE").get();
  const emails = [];
  for (const d of snap.docs) {
    try {
      const u = await admin.auth().getUser(d.id);
      if (u.email) emails.push(u.email);
    } catch (e) { console.error("No auth user for admin", d.id, e.message); }
  }
  return emails;
}

// Queue a mail document once. A fixed id makes retries harmless.
async function queueMail(id, message) {
  try {
    await db.collection("mail").doc(id).create(message);
  } catch (e) {
    if (e.code !== 6 && !/ALREADY_EXISTS/.test(String(e))) throw e; // 6 = already exists
  }
}

/* 1) New student request/offer -> email RC ACTS */
exports.notifyActsRequest = onDocumentCreated("actsRequests/{requestId}", async (event) => {
  const r = event.data.data();
  const to = await rcActsEmails();
  if (!to.length) { console.warn("No active RC ACTS admin with an email."); return; }
  const what = (r.area === "FOODBANK" ? "Foodbank" : "Donation") + " " +
               (r.type === "OFFER" ? "offer" : "request");
  await queueMail("req_" + event.params.requestId, {
    to,
    message: {
      subject: `New ${what} from ${r.requesterName || "a student"}`,
      text: `${what}\n\nFrom: ${r.requesterName || ""} ${r.studentNumber ? "(" + r.studentNumber + ")" : ""}\n` +
            `Room: ${r.room || "-"}\n${r.campaignTitle ? "Campaign: " + r.campaignTitle + "\n" : ""}\n` +
            `Details:\n${r.details}\n\nReview it in ACTS.html (Master Files).`
    }
  });
});

/* 2) Monthly donation reminder. Runs daily; sends at most once per campaign per month. */
exports.monthlyDonationReminder = onSchedule({ schedule: "every day 08:00", timeZone: TZ }, async () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const today = now.getDate();

  const camps = await db.collection("donationCampaigns")
    .where("active", "==", true).where("notifyEnabled", "==", true).get();

  for (const c of camps.docs) {
    const data = c.data();
    if (data.lastNotifiedMonth === month) continue;
    if (today < (data.monthlyDay || 1)) continue;   // not yet the day (a missed day still sends later)

    // Claim this month atomically BEFORE sending, so a retry cannot double-send.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(c.ref);
      if (fresh.data().lastNotifiedMonth === month) return false;
      tx.update(c.ref, { lastNotifiedMonth: month, lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) continue;

    const users = await db.collection("users").where("status", "==", "ACTIVE").get();
    const uids = users.docs.map(u => u.id);
    const emails = [];
    for (let i = 0; i < uids.length; i += 100) {
      const res = await admin.auth().getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
      res.users.forEach(u => { if (u.email) emails.push(u.email); });
    }
    for (let i = 0, n = 0; i < emails.length; i += 90, n++) {
      await queueMail(`camp_${c.id}_${month}_${n}`, {
        bcc: emails.slice(i, i + 90),
        message: {
          subject: `Reminder: ${data.title} donation drive this month`,
          text: `Hi,\n\nThis is a reminder that the "${data.title}" donation drive is coming up this month.\n` +
                `${data.description || ""}\n\nYou can offer a donation on the Foodbank page in Master Files.`
        }
      });
    }
  }
});
